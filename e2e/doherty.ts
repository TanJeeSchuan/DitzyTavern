import type { BrowserContext } from "@playwright/test";

/** @approved The Doherty Threshold: a user's action shows a response within 400 ms. */
const BUDGET = 400;
/** @approved Longer than the budget, so a response that waits on the server always misses it. */
const API_LATENCY = 1500;

export type DohertyViolation = { kind: "dead" | "slow-ack" | "jank"; name: string; ms?: number };

declare global {
	interface Window { reportDoherty: (violation: DohertyViolation) => void }
}

// @approved
// Runs in the page. A trusted click on a control must change a rendered part
// of the DOM and paint within the budget, counted from the press that started
// it ("dead" when nothing changed, "slow-ack" when the paint came late), and
// no click or keypress may take longer than the budget to reach its next paint
// ("jank", from Event Timing; hovers carry no interactionId). A change counts
// when its container is shown, so hiding a panel answers the click that hid it.
// Text fields are left out: focus and caret are their acknowledgement and
// change no DOM.
const detect = (budget: number) => {
	const controls = "button,a[href],summary,[role=button],[role=switch],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio]";
	const label = (element: Element) => `${element.getAttribute("role") ?? element.tagName.toLowerCase()} "${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40)}"`;
	const shown = (node: Node | null) => node instanceof Element && node.checkVisibility({ opacityProperty: true, visibilityProperty: true });
	let changedAt = -Infinity;
	let pressedControl: Element | null = null;
	let pressedAt = 0;
	const waiting = new Set<() => void>();
	new MutationObserver((records) => {
		if (!records.some(({ type, target }) => shown(type === "childList" ? target : target.parentNode))) return;
		changedAt = performance.now();
		for (const answer of waiting) answer();
	}).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	// @approved
	// Some controls, such as Radix menu triggers, answer on pointerdown, before the click fires.
	const pressed = (event: Event) => {
		if (event.isTrusted && event.target instanceof Element) [pressedControl, pressedAt] = [event.target.closest(controls), event.timeStamp];
	};
	addEventListener("pointerdown", pressed, { capture: true });
	addEventListener("keydown", pressed, { capture: true });
	addEventListener("click", (event) => {
		const control = event.target instanceof Element ? event.target.closest(controls) : null;
		if (!event.isTrusted || control === null) return;
		const start = pressedControl === control ? pressedAt : event.timeStamp;
		if (changedAt >= start) return;
		const name = label(control);
		const answer = () => {
			waiting.delete(answer);
			clearTimeout(timer);
			requestAnimationFrame(() => setTimeout(() => {
				const ms = Math.round(performance.now() - start);
				if (ms > budget) window.reportDoherty({ kind: "slow-ack", name, ms });
			}));
		};
		const timer = setTimeout(() => { waiting.delete(answer); window.reportDoherty({ kind: "dead", name }); }, budget - (performance.now() - start));
		waiting.add(answer);
	}, { capture: true });
	// @approved
	// TypeScript's DOM types predate `durationThreshold`; a variable skips the excess-property check.
	const eventTiming = { type: "event", durationThreshold: budget + 1, buffered: true };
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) if (entry instanceof PerformanceEventTiming && entry.interactionId > 0) {
			const target = entry.target instanceof Element ? label(entry.target) : "a removed element";
			window.reportDoherty({ kind: "jank", name: `${entry.name} on ${target}`, ms: entry.duration });
		}
	}).observe(eventTiming);
};

/** @approved Delays every page's API calls past the budget and records every action a page leaves unanswered within it. */
export const watchDoherty = async (context: BrowserContext) => {
	const violations: DohertyViolation[] = [];
	await context.exposeFunction("reportDoherty", (violation: DohertyViolation) => violations.push(violation));
	await context.addInitScript(detect, BUDGET);
	// @approved
	// The change stream carries other tabs' edits, not answers to this page's actions.
	await context.route("**/api/**", async (route) => {
		if (!route.request().url().endsWith("/api/changes")) await new Promise((resolve) => setTimeout(resolve, API_LATENCY));
		await route.fallback();
	});
	// @approved
	// The last click's deadline may still be running when the test returns.
	return async () => {
		await new Promise((resolve) => setTimeout(resolve, BUDGET + 100));
		return violations;
	};
};
