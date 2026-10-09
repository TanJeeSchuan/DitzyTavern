// Drives one generation against a fresh paced fixture server (server.ts) and records what the eye would see.
// Needs a built client (`bun run build`). Run with Node; VH sets the viewport height (default 900).
//   node scripts/stream-eyes/eyes.mjs trace <cps> <out>   → trace.json (reveal spans, DOM mutations, SSE reads,
//                                                          per-frame animation progress and geometry) + screencast frames
//   node scripts/stream-eyes/eyes.mjs scrub <cps> <out>   → freezes the second paragraph's reveal and screenshots it
//                                                          at fixed animation times, plus its keyframes
// Then: python scripts/stream-eyes/analyze.py <out>   and   VH=<same> python scripts/stream-eyes/viz.py <out>
import { chromium } from "playwright";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { join } from "node:path";

const [mode, cps, out] = process.argv.slice(2);
const HERE = import.meta.dirname;
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "frames"), { recursive: true });

const server = spawn("bun", [join(HERE, "server.ts"), mkdtempSync(join(tmpdir(), "eyes-"))], { cwd: join(HERE, "../.."), env: { ...process.env, CPS: cps }, stdio: ["ignore", "pipe", "inherit"] });
process.once("exit", () => server.kill());
const url = await new Promise((resolve) => createInterface({ input: server.stdout }).on("line", (line) => line.startsWith("CRAWLER_READY ") && resolve(line.slice(14))));
const browser = await chromium.launch({ args: ["--force-color-profile=srgb", "--disable-lcd-text", "--font-render-hinting=none"] });
const page = await browser.newPage({ viewport: { width: 1280, height: +(process.env.VH ?? 900) } });

await page.addInitScript(() => {
	const trace = (window.__trace = { events: [], frames: [], origin: performance.timeOrigin });
	const realFetch = window.fetch;
	window.fetch = async (...args) => {
		const response = await realFetch(...args);
		if (!(response.headers.get("content-type") ?? "").includes("event-stream")) return response;
		const [mine, theirs] = response.body.tee();
		(async () => {
			const reader = mine.getReader();
			const decoder = new TextDecoder();
			for (let r = await reader.read(); !r.done; r = await reader.read()) {
				const text = decoder.decode(r.value);
				trace.events.push({ type: "sse", t: performance.now(), bytes: r.value.length, contentChars: text.split("\"type\":\"content\"").length - 1 });
			}
		})();
		return new Response(theirs, response);
	};
	const live = new Map(); // reveal element → { id, t, kind, chars, last }
	let nextId = 0;
	const now = () => performance.now();
	const revealOf = (node) => node instanceof HTMLElement && [...node.classList].some((name) => name.startsWith("animate-")) && node.closest(".prose-block") ? node : null;
	// 0 while waiting out its delay, 1 once finished.
	const progress = (element) => element.getAnimations()[0]?.effect.getComputedTiming().progress ?? 1;
	new MutationObserver((records) => {
		const t = now();
		for (const record of records) {
			const block = record.target instanceof Element ? record.target.closest(".prose-block") : null;
			if (block) trace.events.push({ type: "mutation", t, block: [...block.parentElement.children].indexOf(block), target: record.target.nodeName,
				added: [...record.addedNodes].map((n) => n.nodeName + ":" + n.textContent.length),
				removed: [...record.removedNodes].map((n) => n.nodeName + ":" + n.textContent.length), html: block.innerHTML.length });
			for (const node of record.addedNodes) {
				const element = revealOf(node);
				if (!element) continue;
				const entry = { id: nextId++, t, kind: element.tagName === "SPAN" ? "span" : "block", chars: element.textContent.length, text: element.textContent.slice(0, 40), last: 0 };
				live.set(element, entry);
				trace.events.push({ type: "add", ...entry });
			}
			for (const node of record.removedNodes) {
				const reveals = node instanceof HTMLElement ? [node, ...node.querySelectorAll("*")].map(revealOf).filter(Boolean) : [];
				for (const element of reveals) {
					const entry = live.get(element);
					if (!entry) continue;
					live.delete(element);
					trace.events.push({ type: "remove", id: entry.id, kind: entry.kind, t, age: t - entry.t, lastProgress: entry.last });
				}
			}
		}
	}).observe(document, { childList: true, subtree: true });
	const sample = () => {
		const progresses = [];
		for (const [element, entry] of live) {
			entry.last = progress(element);
			progresses.push([entry.id, entry.last]);
		}
		const article = [...document.querySelectorAll("article")].at(-1);
		const blocks = [...(article?.querySelectorAll(".prose-block") ?? [])].map((block) => { const r = block.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; });
		const box = article?.getBoundingClientRect();
		trace.frames.push({ t: now(), chars: article?.querySelector(".prose-block")?.parentElement?.textContent.length ?? 0, progresses, blocks,
			article: box && [box.left, box.top, box.right, box.bottom] });
		requestAnimationFrame(sample);
	};
	requestAnimationFrame(sample);
});

await page.goto(url);
await page.getByRole("textbox", { name: "Message draft" }).waitFor();
await page.evaluate(() => { window.__trace.events.length = 0; window.__trace.frames.length = 0; });

const cdp = await page.context().newCDPSession(page);
const shots = [];
if (mode === "trace") {
	cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
		const file = `${String(shots.length).padStart(4, "0")}.png`;
		writeFileSync(join(out, "frames", file), Buffer.from(data, "base64"));
		shots.push({ file, wall: metadata.timestamp * 1000 });
		cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
	});
	await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
}

await page.getByRole("textbox", { name: "Message draft" }).fill("Knock knock.");
await page.getByRole("button", { name: /^(Send|Generate)/ }).last().click();
const exact = page.getByRole("button", { name: "Send exact plan" });
if (await exact.waitFor({ timeout: 3000 }).then(() => true, () => false)) await exact.click();

if (mode === "scrub") {
	// Freeze the second paragraph's reveal, then scrub its animations.
	const handle = await page.waitForFunction(() => [...document.querySelectorAll("article")].at(-1)?.querySelectorAll(".prose-block")[1], null, { timeout: 60_000, polling: "raf" });
	await page.evaluate(() => document.getAnimations().forEach((animation) => animation.pause()));
	const block = handle.asElement();
	const info = await block.evaluate((element) => element.getAnimations({ subtree: true }).map((a) => ({ name: a.animationName,
		timing: a.effect.getComputedTiming(), keyframes: a.effect.getKeyframes() })));
	writeFileSync(join(out, "animations.json"), JSON.stringify(info, null, 1));
	for (const t of [0, 100, 200, 300, 400, 500, 600]) {
		await block.evaluate((element, t) => element.getAnimations({ subtree: true }).forEach((animation) => { animation.currentTime = t; }), t);
		await block.screenshot({ path: join(out, "frames", `scrub-${String(t).padStart(3, "0")}.png`), animations: "allow" });
	}
} else {
	await page.getByText("patience than with words.").waitFor({ timeout: 120_000 });
	await page.waitForTimeout(1500);
	await cdp.send("Page.stopScreencast");
	const trace = await page.evaluate(() => window.__trace);
	writeFileSync(join(out, "trace.json"), JSON.stringify({ ...trace, shots }));
}
await browser.close();
server.kill();
process.exit(0);
