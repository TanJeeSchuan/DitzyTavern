// @approved
//  Profiles the browser while the app opens a Chat and streams a reply.
// Serve a database copy first with `bun run profile:actions <database>
// --serve=3100 --token-ms=20` after `bunx vite build --minify false`, then
// run `bun scripts/profile-browser.ts http://127.0.0.1:3100/`. Each phase
// writes a Chrome CPU profile to .scratch/profile/ and the report lists its
// wall time, long tasks and hottest functions by self time.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "@playwright/test";

const url = process.argv[2] ?? "http://127.0.0.1:3100/";
const directory = join(process.cwd(), ".scratch", "profile");
mkdirSync(directory, { recursive: true });

declare global {
	interface Window { longTasks?: number[] }
}

type ProfileNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number };
type CpuProfile = { nodes: ProfileNode[]; startTime: number; endTime: number; samples?: number[]; timeDeltas?: number[] };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
await page.addInitScript(() => {
	const durations: number[] = [];
	window.longTasks = durations;
	new PerformanceObserver((list) => durations.push(...list.getEntries().map((entry) => entry.duration))).observe({ type: "longtask" });
});

const longTasks = (target: Page) => target.evaluate(() => {
	return window.longTasks?.splice(0) ?? [];
});

// @approved Self time per function, from the samples' time deltas, so a hot function shows even when its callers vary.
const hottest = (profile: CpuProfile) => {
	const byId = new Map(profile.nodes.map((node) => [node.id, node]));
	const self = new Map<string, number>();
	for (const [index, sample] of (profile.samples ?? []).entries()) {
		const frame = byId.get(sample)?.callFrame;
		if (frame === undefined) continue;
		const file = frame.url.split("/").at(-1) ?? "";
		const key = `${frame.functionName || "(anonymous)"} ${file}:${frame.lineNumber + 1}`;
		self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas?.[index] ?? 0) / 1000);
	}
	return [...self].filter(([key]) => !key.startsWith("(idle)") && !key.startsWith("(program)")).sort((left, right) => right[1] - left[1]).slice(0, 15);
};

const lines = ["# Browser profile", ""];
const phase = async (name: string, session: CDPSession, run: () => Promise<void>) => {
	await longTasks(page);
	await session.send("Profiler.start");
	const start = performance.now();
	await run();
	const elapsed = performance.now() - start;
	const { profile } = await session.send("Profiler.stop");
	await Bun.write(join(directory, `${name.replaceAll(" ", "-").toLowerCase()}.cpuprofile`), JSON.stringify(profile));
	const tasks = await longTasks(page);
	lines.push(
		`## ${name}`, "",
		`${elapsed.toFixed(0)} ms wall · ${tasks.length} long tasks totalling ${tasks.reduce((sum, value) => sum + value, 0).toFixed(0)} ms, longest ${Math.max(0, ...tasks).toFixed(0)} ms`, "",
		"| Self ms | Function |", "| ---: | --- |",
		...hottest(profile).map(([key, ms]) => `| ${ms.toFixed(1)} | \`${key}\` |`), "",
	);
};

const story = page.getByRole("main", { name: "Active Chat" });
await phase("Open the latest Chat", cdp, async () => {
	await page.goto(url);
	await story.locator("article").first().waitFor({ timeout: 60_000 });
	await page.waitForLoadState("networkidle");
});
// @approved
//  Waits on network events rather than locators: Playwright polls a locator
// by querying the whole page, which would land in the profile. Send and New
// Swipe open the inspected plan first when that setting is on, and the
// preview's request tells which way this Chat went.
const streamed = async (start: () => Promise<void>) => {
	const events = page.waitForRequest((request) => request.url().includes("/events"), { timeout: 30_000 });
	const previewed = page.waitForResponse((response) => response.url().endsWith("/generations/preview"), { timeout: 30_000 }).then(() => true, () => false);
	await start();
	if (await Promise.race([previewed, events.then(() => false)])) await page.getByRole("button", { name: "Send exact plan" }).click();
	await (await (await events).response())?.finished();
	await page.waitForTimeout(1_000);
};
await phase("Stream a reply", cdp, async () => {
	await page.getByRole("textbox", { name: "Message draft" }).fill("The lantern gutters as the door opens.");
	await streamed(() => page.getByRole("button", { name: "Generate Variant" }).click());
});
await phase("Stream a new Swipe", cdp, async () => {
	await streamed(() => story.locator("article").last().getByRole("button", { name: "New Swipe" }).click());
});
await phase("Browse to the previous Swipe", cdp, async () => {
	await story.locator("article").last().getByRole("button", { name: "Previous Swipe" }).click();
	await page.waitForLoadState("networkidle");
});

await browser.close();
await Bun.write(join(directory, "browser.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
