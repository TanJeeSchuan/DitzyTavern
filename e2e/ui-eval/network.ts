import type { Page } from "@playwright/test";

export const apiLatencyMs = Number(process.env.UI_EVAL_LATENCY_MS ?? "0");
if (!Number.isFinite(apiLatencyMs) || apiLatencyMs < 0) throw new Error("UI_EVAL_LATENCY_MS must be a finite, nonnegative number.");

export const applyApiLatency = async (page: Page, baseURL: string, latencyMs = apiLatencyMs) => {
	const session = await page.context().newCDPSession(page);
	await session.send("Network.enable");
	await session.send("Network.emulateNetworkConditionsByRule", {
		matchedNetworkConditions: [{
			urlPattern: new URL("/api/*", baseURL).href,
			latency: latencyMs,
			downloadThroughput: -1,
			uploadThroughput: -1,
		}],
	});
};
