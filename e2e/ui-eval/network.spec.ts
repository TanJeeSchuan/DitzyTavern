import { Value } from "@sinclair/typebox/value";
import { workspaceResponse } from "../../src/shared/contract/workspace";
import { test, expect } from "../fixtures";
import { applyApiLatency } from "./network";

test("API latency emulation delays a real browser response", async ({ page, llm, request }, testInfo) => {
	const expected = Value.Parse(workspaceResponse, await (await request.get("/api/workspace")).json());
	await applyApiLatency(page, llm.url, 250);
	await page.goto("/");
	const result = await page.evaluate(async () => {
		const started = performance.now();
		// A distinct URL prevents consuming the document's already-started workspace preload.
		const response = await fetch("/api/workspace?ui-eval-network-validation", { cache: "no-store" });
		return { status: response.status, body: await response.json(), durationMs: performance.now() - started };
	});
	await testInfo.attach("network-validation.json", { body: JSON.stringify({ latencyMs: 250, ...result }), contentType: "application/json" });
	expect(result.status).toBe(200);
	expect(Value.Parse(workspaceResponse, result.body).activeChatId).toBe(expected.activeChatId);
	expect(result.durationMs, "the real API response cannot bypass the configured latency floor").toBeGreaterThanOrEqual(225);
});
