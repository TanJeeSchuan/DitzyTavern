import { Type, type Static } from "@sinclair/typebox";
import type { GenerationEvent, GenerationStatePayload } from "../../src/shared/contract/generation-events";

const sampleLabels = {
	name: Type.String(),
	budgetMs: Type.Number(),
	warmup: Type.Boolean(),
};
export const samplesSchema = Type.Array(Type.Union([Type.Object({
	...sampleLabels,
	durationMs: Type.Number(),
	startedAtMs: Type.Number(),
	endedAtMs: Type.Number(),
	outcome: Type.Union([Type.Literal("observed"), Type.Literal("timed-out")]),
}), Type.Object({ ...sampleLabels, outcome: Type.Literal("unavailable"), reason: Type.String() })]));
export type Sample = Static<typeof samplesSchema>[number];
type TimedSample = Exclude<Sample, { outcome: "unavailable" }>;

export type Measurement = {
	name: string;
	budgetMs: number;
	timeoutMs: number;
	warmup: boolean;
	result: { selector: string; text?: string; ready?: boolean };
	trigger: { kind: "click" | "keydown"; selector: string } | { kind: "stream"; text: string };
};

declare global {
	interface Window {
		uiEval: ReturnType<typeof installProbe>;
	}
}

export function installProbe() {
	const isContent = (value: unknown): value is Extract<GenerationEvent, { type: "content" }> =>
		typeof value === "object" && value !== null && "type" in value && value.type === "content" && "text" in value && typeof value.text === "string";
	const isSnapshot = (value: unknown): value is Pick<GenerationStatePayload, "content"> =>
		typeof value === "object" && value !== null && "content" in value && typeof value.content === "string";
	const samples: Sample[] = [];
	const arrivals: { at: number; text: string }[] = [];
	const errors: string[] = [];
	let onInput = (_event: Event) => {};
	let onStream = (_text: string) => {};
	let pending: Promise<TimedSample>;
	let observing = false;
	const channel = new MessageChannel();
	let afterFrame = () => {};
	channel.port1.onmessage = () => afterFrame();
	for (const name of ["click", "keydown"]) document.addEventListener(name, (event) => onInput(event), true);

	const realFetch = window.fetch;
	window.fetch = new Proxy(realFetch, { async apply(target, _receiver, args: Parameters<typeof fetch>) {
		const response = await target(...args);
		if (!response.url.match(/\/generations\/\d+\/events/) || response.body === null) return response;
		const reader = response.clone().body!.getReader();
		void (async () => {
			const decoder = new TextDecoder();
			let buffer = "";
			let text = "";
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) break;
					buffer += decoder.decode(next.value, { stream: true });
					const frames = buffer.split(/\r?\n\r?\n/);
					buffer = frames.pop() ?? "";
					for (const frame of frames) {
						const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
						if (!data) continue;
						const payload: unknown = JSON.parse(data);
						const before = text;
						if (isContent(payload)) text += payload.text;
						if (isSnapshot(payload)) text = payload.content;
						if (text !== before) {
							arrivals.push({ at: performance.now(), text });
							onStream(text);
						}
					}
				}
			} catch (error) {
				if (error instanceof SyntaxError) errors.push(error.message);
			} finally { reader.releaseLock(); }
		})();
		return response;
	} });

	const arm = (measurement: Measurement) => {
		if (observing) throw new Error("A measurement is already active.");
		observing = true;
		pending = new Promise<TimedSample>((resolve, reject) => {
			let start: number | undefined;
			let frame = 0;
			const cleanup = () => {
				observing = false;
				clearTimeout(timer);
				cancelAnimationFrame(frame);
				onInput = () => {};
				onStream = () => {};
				afterFrame = () => {};
			};
			const finish = (outcome: TimedSample["outcome"]) => {
				if (!observing || start === undefined) return;
				const end = performance.now();
				const sample = {
					name: measurement.name, budgetMs: measurement.budgetMs, durationMs: end - start,
					startedAtMs: start, endedAtMs: end, outcome, warmup: measurement.warmup,
				};
				cleanup();
				samples.push(sample);
				resolve(sample);
			};
			const ready = () => {
				const element = document.querySelector(measurement.result.selector);
				if (!(element instanceof HTMLElement) || !element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) return false;
				if (measurement.result.text !== undefined && !element.textContent.includes(measurement.result.text)) return false;
				return !measurement.result.ready || (!element.matches(":disabled") && document.querySelector('[aria-label="Message draft"][contenteditable="true"]') !== null);
			};
			const check = () => {
				if (!observing || start === undefined || frame) return;
				frame = requestAnimationFrame(() => {
					frame = 0;
					if (!ready()) { check(); return; }
					afterFrame = () => { if (ready()) finish("observed"); else check(); };
					channel.port2.postMessage(null);
				});
			};
			let timer = setTimeout(() => {
				cleanup();
				reject(new Error(`No browser origin observed for ${measurement.name}.`));
			}, 10_000);
			const begin = (at: number) => {
				if (start !== undefined) return;
				start = at;
				clearTimeout(timer);
				timer = setTimeout(() => finish("timed-out"), measurement.timeoutMs);
				window.dispatchEvent(new Event("ui-eval-start"));
				check();
			};
			const trigger = measurement.trigger;
			if (trigger.kind === "stream") onStream = (text) => { if (text.includes(trigger.text)) begin(performance.now()); };
			else onInput = (event) => {
				if (event.isTrusted && event.type === trigger.kind && event.target instanceof Element && event.target.closest(trigger.selector)) begin(event.timeStamp);
			};
		});
	};
	const unavailable = (sample: Pick<Extract<Sample, { outcome: "unavailable" }>, "name" | "budgetMs" | "reason">) =>
		samples.push({ ...sample, outcome: "unavailable", warmup: false });
	const probe = { arm, unavailable, result: () => pending, read: () => ({ samples, arrivals, errors }) };
	window.uiEval = probe;
	return probe;
}
