import { describe, expect, test } from "bun:test";
import type { ConnectionProfile } from "../connection-settings/types";
import { resolvePromptImages, type PromptBlock, type PromptPlan } from "../prompt-compiler";
import { formatImageReference } from "../../shared/image-reference";
import {
	collectModelClientGeneration,
	createOpenAICompatibleModelClient,
	type ModelClientGenerationInput,
} from ".";

const profile: ConnectionProfile = {
	id: 3,
	displayName: "Local",
	apiFormat: "chat-completions",
	requestUrl: "http://127.0.0.1:43127/v1/chat/completions",
	modelsUrl: "",
	modelBackend: "automatic",
	adapter: "openai-compatible",
	outputTokenRepresentation: "omit",
	timeoutMs: 120_000,
	pinnedModels: [],
	discoveryCatalog: [],
	textOnlyModels: [],
	credentialConfigured: false,
	headers: [],
};

const settings = {
	temperature: null,
	topP: null,
	frequencyPenalty: null,
	presencePenalty: null,
	contextLimit: 100,
	responseBudget: 42,
	requestOverrides: {},
};

const mapHash = "a".repeat(64);
const mugHash = "b".repeat(64);
const map = formatImageReference("map", mapHash);
const mug = formatImageReference("mug", mugHash);

const stored = new Map([
	[mapHash, { bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png" }],
	[mugHash, { bytes: new Uint8Array([4, 5, 6]), mediaType: "image/webp" }],
]);

const planOf = (
	blocks: PromptBlock[],
	options: { intent?: PromptPlan["intent"]; placement?: "first" | "last" | "every"; known?: readonly string[]; sendImages?: boolean } = {},
): PromptPlan => {
	const known = options.known ?? [mapHash, mugHash];
	return resolvePromptImages(
		{ blocks, warnings: [], intent: options.intent },
		{ lookup: (hash) => known.includes(hash) ? { width: 20, height: 20 } : undefined, placement: options.placement ?? "every" },
		options.sendImages ?? true,
	);
};

type WireContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
interface WireMessage { role: string; content: WireContent }

// Text parts read as themselves; an image part reads as `<media type:base64 bytes>`.
const readable = (message: WireMessage) => ({
	role: message.role,
	content: Array.isArray(message.content)
		? message.content.map((part) => part.type === "text"
			? part.text ?? ""
			: `<${part.image_url?.url.match(/^data:([^;]+);base64,(.*)$/)?.slice(1).join(":")}>`)
		: message.content,
});

const sentTo = async (
	input: Pick<ModelClientGenerationInput, "promptPlan" | "assistantPrefill">,
	options: { textOnlyModels?: string[]; loadable?: boolean } = {},
) => {
	let calls = 0;
	let body: { messages: WireMessage[] } | undefined;
	const client = createOpenAICompatibleModelClient({
		profile: { ...profile, textOnlyModels: options.textOnlyModels ?? [] },
		secrets: null,
		loadImage: options.loadable === false ? undefined : (hash) => stored.get(hash),
		fetch: async (_url, init) => {
			calls += 1;
			// SAFETY: the controlled fake receives the adapter's JSON request body.
			body = JSON.parse(String(init?.body)) as { messages: WireMessage[] };
			return new Response([
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }] })}\n\n`,
				`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
				"data: [DONE]\n\n",
			].join(""), { headers: { "content-type": "text/event-stream" } });
		},
	});
	const result = collectModelClientGeneration(client, { ...input, modelId: "vision-model", generationSettings: settings });
	return { calls: () => calls, messages: () => (body?.messages ?? []).map(readable), result };
};

const history = (content: string, role: "human" | "model" = "human", speakerName = "Writer"): PromptBlock =>
	({ kind: "history", speakerName, content, role });

const textOf = (messages: ReadonlyArray<{ content: string | string[] }>) =>
	messages.flatMap(({ content }) => Array.isArray(content) ? content.filter((part) => !part.startsWith("<")) : [content]).join("\n");

describe("Model Client Image transport", () => {
	test("sends each Image after its anchor at its position inside a user message", async () => {
		const sent = await sentTo({ promptPlan: planOf([history(`Look at ${map} and then ${mug}. Thoughts?`)]) });
		await sent.result;
		expect(sent.messages()).toEqual([{
			role: "user",
			content: [
				"Writer: Look at [Image: map]",
				"<image/png:AQID>",
				" and then [Image: mug]",
				"<image/webp:BAUG>",
				". Thoughts?",
			],
		}]);
	});

	test("moves Images out of system and assistant messages into the user message that follows", async () => {
		const sent = await sentTo({
			promptPlan: planOf([
				{ kind: "scenario", role: "system", content: `Setting: ${map}` },
				{ kind: "identity", role: "model", content: `I wear ${mug}.` },
				history("Hello"),
			]),
		});
		await sent.result;
		expect(sent.messages()).toEqual([
			{ role: "system", content: "Setting: [Image: map]" },
			{ role: "user", content: ["[Image: map]", "<image/png:AQID>"] },
			{ role: "assistant", content: "I wear [Image: mug]." },
			{ role: "user", content: ["[Image: mug]", "<image/webp:BAUG>"] },
			{ role: "user", content: "Writer: Hello" },
		]);
	});

	test("keeps a Human-authored Message's Images when its seat now writes as the model", async () => {
		const sent = await sentTo({
			promptPlan: planOf([history(`Here ${map}`, "model", "Writer"), history("Reply", "human", "Maren")]),
		});
		await sent.result;
		expect(sent.messages()).toEqual([
			{ role: "assistant", content: "Writer: Here [Image: map]" },
			{ role: "user", content: ["[Image: map]", "<image/png:AQID>"] },
			{ role: "user", content: "Maren: Reply" },
		]);
	});

	test("refuses an assistant prefill that contains an Image before any request", async () => {
		const sent = await sentTo({
			promptPlan: planOf([history(`Earlier ${map}`, "model", "Maren")], {
				intent: { type: "continuation", strategy: "assistant-prefill", suffix: " " },
			}),
		});
		await expect(sent.result).rejects.toMatchObject({ kind: "protocol", message: expect.stringContaining("Image") });
		expect(sent.calls()).toBe(0);
	});

	test("refuses an assistant prefill whose Reference is missing from the store too", async () => {
		const sent = await sentTo({
			promptPlan: planOf([history(`Earlier ${map}`, "model", "Maren")], {
				intent: { type: "continuation", strategy: "assistant-prefill", suffix: "" },
				known: [],
			}),
		});
		await expect(sent.result).rejects.toMatchObject({ kind: "protocol" });
		expect(sent.calls()).toBe(0);
	});

	test("prefills text without Images unchanged and never writes a hash into it", async () => {
		const sent = await sentTo({
			promptPlan: planOf([history("Earlier", "model", "Maren")], {
				intent: { type: "continuation", strategy: "assistant-prefill", suffix: "" },
			}),
		});
		await sent.result;
		expect(sent.messages()).toEqual([{ role: "assistant", content: "Earlier" }]);
	});

	test("text-only prefill receives anchors even for a missing Reference", async () => {
		const sent = await sentTo({
			promptPlan: planOf([history(`Earlier ${map}`, "model", "Maren")], {
				intent: { type: "continuation", strategy: "assistant-prefill", suffix: " " },
				known: [],
				sendImages: false,
			}),
		}, { textOnlyModels: ["vision-model"] });
		await sent.result;
		expect(sent.messages()).toEqual([{ role: "assistant", content: "Earlier [Image: map] " }]);
	});

	test("a Text-only Model receives anchors in place of every Image", async () => {
		const sent = await sentTo(
			{ promptPlan: planOf([{ kind: "scenario", role: "system", content: map }, history(`See ${mug}`)], { sendImages: false }) },
			{ textOnlyModels: ["vision-model"] },
		);
		await sent.result;
		expect(sent.messages()).toEqual([
			{ role: "system", content: "[Image: map]" },
			{ role: "user", content: "Writer: See [Image: mug]" },
		]);
	});

	test("a mark on another model leaves this model receiving Images", async () => {
		const sent = await sentTo({ promptPlan: planOf([history(map)]) }, { textOnlyModels: ["other-model"] });
		await sent.result;
		expect(sent.messages()[0]?.content).toEqual(["Writer: [Image: map]", "<image/png:AQID>"]);
	});

	test("sends only the anchor for a Reference the plan does not send or whose Image is missing", async () => {
		const sent = await sentTo({
			promptPlan: planOf([history(`First ${map}`), history(`Again ${map} and ${mug}`)], {
				placement: "last",
				known: [mapHash],
			}),
		});
		await sent.result;
		expect(sent.messages()).toEqual([
			{ role: "user", content: "Writer: First [Image: map]" },
			{ role: "user", content: ["Writer: Again [Image: map]", "<image/png:AQID>", " and [Image: mug]"] },
		]);
	});

	test("sends the anchor when the store no longer holds the bytes", async () => {
		const sent = await sentTo({ promptPlan: planOf([history(`Look ${map}`)]) }, { loadable: false });
		await sent.result;
		expect(sent.messages()).toEqual([{ role: "user", content: "Writer: Look [Image: map]" }]);
	});

	test("no hash reaches any outgoing text, including a continuation instruction", async () => {
		const sent = await sentTo({
			promptPlan: planOf([
				{ kind: "scenario", role: "system", content: map },
				history(`Look ${mug}`, "model", "Maren"),
				history(`Reply ${map}`),
			], { intent: { type: "continuation", strategy: "instruction", instruction: `Mind ${mug}.` } }),
		});
		await sent.result;
		const text = textOf(sent.messages());
		expect(text).not.toContain(mapHash);
		expect(text).not.toContain(mugHash);
		expect(text).toContain("[Image: mug]");
	});

});
