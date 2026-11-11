import type { Page } from "@playwright/test";
import { Value } from "@sinclair/typebox/value";
import { test, expect, story } from "../fixtures";
import { workspaceResponse } from "../../src/shared/contract/workspace";
import { chatHistoryPage, conversationSummary, conversationCommandBody } from "../../src/shared/contract/conversation-schema";
import { installProbe, type Measurement } from "./probe";

const draft = '[aria-label="Message draft"]';
const stop = 'button[aria-label="Stop Generation"]';
const send = 'button[aria-label="Generate Variant"]';
const repetitions = 20;

const measure = async (page: Page, measurement: Measurement, action: () => Promise<void>) => {
	await page.evaluate((config) => window.uiEval.arm(config), measurement);
	await action();
	return page.evaluate(() => window.uiEval.result());
};

test.beforeEach(async ({ page }) => {
	await page.addInitScript(installProbe);
	await page.addInitScript(() => localStorage.setItem("ditzytavern.inspect-prompt-plan-before-generating", "false"));
});

test.afterEach(async ({ page }, testInfo) => {
	const log = await page.evaluate(() => window.uiEval.read());
	await testInfo.attach("ui-eval.json", { body: JSON.stringify(log), contentType: "application/json" });
	expect(log.errors, "the probe decoded every observed SSE frame").toEqual([]);
});

for (const scenario of [
	{ name: "short sentence", text: "A lantern dims. " },
	{ name: "CJK", text: "灯りが消えた。誰も動かなかった。".repeat(12) },
	{ name: "second paragraph", text: `${"The lantern lights the empty room. ".repeat(4)}\n\nA second paragraph waits here.`, needle: "A second paragraph waits here." },
]) {
	test(`stalled stream: ${scenario.name}`, async ({ page, llm }) => {
		await llm.chat({ chunks: [scenario.text], hold: true });
		await page.goto("/");
		await page.locator(draft).fill("Continue the scene.");
		const needle = scenario.needle ?? scenario.text.trim();
		await measure(page, {
			name: `stalled stream: ${scenario.name}`, budgetMs: 400, timeoutMs: 1500, warmup: false,
			trigger: { kind: "stream", text: needle },
			result: { selector: '.prose[data-generation-active="true"]', text: needle },
		}, () => page.locator(send).click());
		await expect(page.locator(stop)).toBeEnabled();
		await page.locator(stop).click();
		await expect(story(page).locator("article").last()).toContainText(needle);
		await expect(page.locator(send)).toBeEnabled();
	});
}

test("uncached Swipe text", async ({ page, request }) => {
	const workspace = Value.Parse(workspaceResponse, await (await request.get("/api/workspace")).json());
	const url = `/api/conversations/${workspace.activeChatId}`;
	const conversation = Value.Parse(conversationSummary, await (await request.get(url)).json());
	const variants = Array.from({ length: 5 }, (_, index) => `Take ${index + 1}.\n\n${"The lantern casts **long shadows** across the room. ".repeat(160)}`);
	const created = await request.post(`${url}/commands`, { data: {
		expectedRevision: conversation.revision,
		action: { type: "create-message", timestamp: new Date().toISOString(), authorParticipantId: conversation.control.modelParticipantId, variantContents: variants },
	} });
	expect(created.ok()).toBe(true);
	const history = Value.Parse(chatHistoryPage, await (await request.get(`${url}/history`)).json());
	const message = history.messages.at(-1)!;
	const collected = [];
	let release = Promise.withResolvers<void>();
	await page.exposeFunction("releaseSwipe", () => release.resolve());
	for (let index = 0; index <= repetitions; index++) {
		const targetIndex = index % 2 === 0 ? 3 : 0;
		const target = message.variants[targetIndex]!;
		const article = `[data-message-id="${message.id}"]`;
		const direction = targetIndex === 3 ? "Next Swipe" : "Previous Swipe";
		release = Promise.withResolvers<void>();
		const requested = Promise.withResolvers<void>();
		await page.route(`**/variants/${target.id}/text`, async (route) => {
			requested.resolve();
			await release.promise;
			await route.continue();
		});
		await page.goto("/");
		await expect(page.locator(`${article} .prose`)).toContainText(`Take ${targetIndex === 3 ? 1 : 4}.`);
		const next = page.locator(article).getByRole("button", { name: direction, exact: true });
		await next.click();
		await next.click();
		await requested.promise;
		await page.evaluate(() => window.addEventListener("ui-eval-start", () => void window.releaseSwipe(), { once: true }));
		const applied = page.waitForResponse((response) => {
			if (!response.url().endsWith("/commands") || !response.ok()) return false;
			const { action } = Value.Parse(conversationCommandBody, response.request().postDataJSON());
			return action.type === "select-variant" && action.variantId === target.id;
		});
		collected.push(await measure(page, {
			name: "uncached Swipe text", budgetMs: 400, timeoutMs: 5000, warmup: index === 0,
			trigger: { kind: "click", selector: `${article} button[aria-label="${direction}"]` },
			result: { selector: `${article} .prose`, text: `Take ${targetIndex + 1}.` },
		}, () => next.click()));
		await applied;
		await page.unrouteAll({ behavior: "wait" });
	}
	// Navigation resets the browser probe; keep every repetition in the report.
	await test.info().attach("ui-eval-samples.json", { body: JSON.stringify(collected), contentType: "application/json" });
	expect(collected.every((sample) => sample.outcome === "observed"), "every selected Swipe eventually displays its own text").toBe(true);
});

test("Stop restores the composer", async ({ page, llm }) => {
	await llm.chat({ chunks: ["An unfinished reply"], hold: true, repeat: true });
	await page.goto("/");
	for (let index = 0; index <= repetitions; index++) {
		await page.locator(draft).fill(`Continue ${index}.`);
		await page.locator(send).click();
		await expect(page.locator(stop)).toBeEnabled();
		const sample = await measure(page, {
			name: "Stop restores the composer", budgetMs: 400, timeoutMs: 5000, warmup: index === 0,
			trigger: { kind: "click", selector: stop }, result: { selector: send, ready: true },
		}, () => page.locator(stop).click());
		expect(sample.outcome, "Stop returns control to the writer").toBe("observed");
	}
});

test("typing while chunks arrive", async ({ page, llm }) => {
	await llm.chat({ chunks: Array.from({ length: 120 }, (_, index) => `The lantern flickers ${index}.\n\n`), delayMs: 80, hold: true });
	await page.goto("/");
	await page.locator(draft).fill("Continue.");
	await page.locator(send).click();
	await expect(story(page).getByText("The lantern flickers 0.", { exact: true })).toBeVisible();
	if (await page.locator(draft).getAttribute("contenteditable") === "false") {
		await page.evaluate(() => window.uiEval.unavailable({
			name: "typing while chunks arrive", budgetMs: 50, reason: "The composer is disabled during generation.",
		}));
		await page.locator(stop).click();
		await expect(page.locator(send)).toBeEnabled();
		return;
	}
	await expect(page.locator(draft)).toHaveAttribute("contenteditable", "true");
	await page.locator(draft).focus();
	const arrivals = await page.evaluate(() => window.uiEval.read().arrivals.length);
	for (let index = 0; index <= repetitions; index++) {
		const sample = await measure(page, {
			name: "typing while chunks arrive", budgetMs: 50, timeoutMs: 5000, warmup: index === 0,
			trigger: { kind: "keydown", selector: draft }, result: { selector: draft, text: "x".repeat(index + 1) },
		}, () => page.keyboard.press("x"));
		expect(sample.outcome, "each typed character appears in the draft").toBe("observed");
	}
	expect(await page.evaluate(() => window.uiEval.read().arrivals.length), "the typing samples overlap incoming provider chunks").toBeGreaterThan(arrivals + 1);
	await page.locator(stop).click();
	await expect(page.locator(send)).toBeEnabled();
});

test("the probe detects a 500 ms main-thread stall", async ({ page }) => {
	await page.goto("/");
	await page.locator(draft).fill("");
	await page.locator(draft).focus();
	await page.evaluate(() => document.addEventListener("keydown", () => {
		const until = performance.now() + 500;
		while (performance.now() < until) {}
	}, { capture: true, once: true }));
	const sample = await measure(page, {
		name: "probe validation: 500 ms stall", budgetMs: 400, timeoutMs: 5000, warmup: false,
		trigger: { kind: "keydown", selector: draft }, result: { selector: draft, text: "x" },
	}, () => page.keyboard.press("x"));
	expect(sample.outcome).toBe("observed");
	expect(sample.durationMs, "the clock includes work before the editor handles the key").toBeGreaterThanOrEqual(500);
});
