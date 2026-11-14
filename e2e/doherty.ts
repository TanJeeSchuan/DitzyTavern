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
// of the DOM and paint within the budget ("dead" when nothing changed, "slow-ack" when the
// paint came late), and no click or keypress may take longer than the budget
// to reach its next paint ("jank", from Event Timing; hovers carry no
// interactionId). Text fields are left out: focus and caret are their
// acknowledgement and change no DOM.
const detect = (budget: number) => {
	const controls = "button,a[href],summary,[role=button],[role=switch],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio]";
	const label = (element: Element) => `${element.getAttribute("role") ?? element.tagName.toLowerCase()} "${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40)}"`;
	addEventListener("click", (event) => {
		const control = event.target instanceof Element ? event.target.closest(controls) : null;
		if (!event.isTrusted || control === null) return;
		const name = label(control);
		const observer = new MutationObserver((records) => {
			if (!records.some(({ target }) => (target instanceof Element ? target : target.parentElement)?.checkVisibility())) return;
			observer.disconnect();
			clearTimeout(timer);
			requestAnimationFrame(() => setTimeout(() => {
				const ms = Math.round(performance.now() - event.timeStamp);
				if (ms > budget) window.reportDoherty({ kind: "slow-ack", name, ms });
			}));
		});
		observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
		const timer = setTimeout(() => { observer.disconnect(); window.reportDoherty({ kind: "dead", name }); }, budget);
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
