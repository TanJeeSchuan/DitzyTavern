#!/usr/bin/env node
/**
 * Deterministic screenshot capture for DitzyTavern.
 *
 * NOTE: run with Node, not Bun — Bun's child_process pipe transport hangs
 * Playwright's Chromium launch (verified: bun times out, node is fine).
 *
 * Captures a fixed set of UI states against the production build served by
 * the Bun/Elysia server (no Vite, no HMR, no DB fixture handling — the app
 * is used exactly as-is).
 *
 * Determinism levers:
 *  - pinned browser build (playwright devDependency) + installed chromium
 *  - fixed viewport / deviceScaleFactor / locale / timezone / colorScheme
 *  - reducedMotion + forced sRGB color profile + no LCD text
 *  - all CSS transitions/animations disabled, caret hidden (addInitScript)
 *  - waits on semantic locators (aria labels), never sleeps; fonts.ready
 *  - stable filenames NN-state.png + manifest.json (no timestamps in images)
 *  - strict network/console guard: any page error or >=400 response fails
 *
 * Usage:
 *   bun scripts/capture-screenshots.ts                 # build + serve + capture
 *   bun scripts/capture-screenshots.ts --dev           # reuse a running server (no build)
 *   bun scripts/capture-screenshots.ts --only=chat,cast
 *   bun scripts/capture-screenshots.ts --out=./shots --scale=1 --viewport=1280x800
 *   bun scripts/capture-screenshots.ts --allow-errors  # don't fail on console noise
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// ── CLI ────────────────────────────────────────────────────────────────

const arg = (name: string, fallback?: string) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const BASE = arg("base", process.env.BASE_URL ?? "http://127.0.0.1:3000");
const OUT_DIR = join(ROOT, arg("out", ".scratch/screenshots/deterministic"));
const [viewportWidth, viewportHeight] = (arg("viewport", "1440x900") ?? "1440x900")
	.split("x")
	.map(Number);
const VIEWPORT: [number, number] = [viewportWidth, viewportHeight];
const SCALE = Number(arg("scale", "2") ?? "2");
const ONLY = (arg("only") ?? "").split(",").filter(Boolean);
const DEV = flag("dev");
const ALLOW_ERRORS = flag("allow-errors");
const KEEP_SERVER = flag("keep-server");

// ── State table ────────────────────────────────────────────────────────

type Capture = {
	name: string;
	/** Actions to reach the state from the home URL. */
	steps: Array<(page: any) => Promise<void>>;
	/** Semantic wait that proves the state is fully rendered. */
	ready: (page: any) => Promise<void>;
};

const rail = (page: any, label: string) =>
	page
		.locator('nav[aria-label="Workspace"]')
		.getByRole("button", { name: label, exact: true });

const waitHeading = (page: any, text: string) =>
	page.getByRole("heading", { name: text, exact: true }).waitFor({ state: "visible" });

const STATES: Capture[] = [
	{
		name: "01-chat",
		steps: [],
		ready: async (page) => {
			await waitHeading(page, "Active Chat").catch(() => undefined); // header label is a generic
			await page.locator('main[aria-label="Active Chat"] h1').waitFor({ state: "visible" });
			await page.getByRole("textbox", { name: "Message draft" }).waitFor({ state: "visible" });
		},
	},
	{
		name: "02-chats-panel",
		steps: [(page) => rail(page, "Chats").click()],
		ready: async (page) => {
			await waitHeading(page, "Chats");
			await page.getByRole("button", { name: "New Chat", exact: true }).waitFor();
		},
	},
	{
		name: "03-cast-panel",
		steps: [(page) => rail(page, "Cast").click()],
		ready: async (page) => {
			await waitHeading(page, "Cast");
			await page.getByRole("button", { name: "Add Participant", exact: true }).waitFor();
		},
	},
	{
		name: "04-library",
		steps: [(page) => rail(page, "Library").click()],
		ready: async (page) => {
			await waitHeading(page, "Character Library");
			await page.locator(".character-list-item").first().waitFor();
		},
	},
	{
		name: "05-library-character",
		steps: [
			(page) => rail(page, "Library").click(),
			// Open the first library entry's editor. Deterministic: pinned
			// characters sort first, and "Maren Voss" is the first pinned seed.
			(page) => page.locator(".character-list-item").first().click(),
		],
		ready: async (page) => {
			await page.getByRole("textbox", { name: "Character name" }).waitFor({ state: "visible" });
		},
	},
	{
		name: "06-new-chat",
		steps: [
			(page) => rail(page, "Chats").click(),
			(page) => page.getByRole("button", { name: "New Chat", exact: true }).click(),
		],
		ready: async (page) => {
			await waitHeading(page, "New Chat");
			await page.getByRole("textbox", { name: "Chat name" }).waitFor();
			await page.getByRole("button", { name: "Create Chat" }).waitFor();
		},
	},
	{
		name: "07-settings-daylight",
		steps: [
			(page) => rail(page, "Settings").click(),
			(page) => page.getByRole("button", { name: "Daylight", exact: true }).click(),
		],
		ready: (page) =>
			page.locator("html[data-theme=daylight]").waitFor({ state: "attached" }),
	},
	{
		name: "08-settings-evening",
		steps: [
			(page) => rail(page, "Settings").click(),
			(page) => page.getByRole("button", { name: "Evening", exact: true }).click(),
		],
		ready: (page) =>
			page.locator("html[data-theme=evening]").waitFor({ state: "attached" }),
	},
];

// ── Server lifecycle ───────────────────────────────────────────────────

const spawnServer = (): ChildProcess => {
	const build = spawn("bun", ["run", "build"], {
		cwd: ROOT,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, TZ: "UTC" },
	});
	return build;
};

const health = async (): Promise<boolean> => {
	try {
		const res = await fetch(`${BASE}/api/health`);
		return res.status === 200;
	} catch {
		return false;
	}
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForServer = async (child: ChildProcess | null, timeoutMs = 60_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (child && child.exitCode !== null) {
			throw new Error(`Server process exited early (code ${child.exitCode}).`);
		}
		if (await health()) return;
		await sleep(500);
	}
	throw new Error(`Server did not become healthy at ${BASE} within ${timeoutMs}ms.`);
};

// ── Determinism setup ──────────────────────────────────────────────────

const DETERMINISM_CSS = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    scroll-behavior: auto !important;
  }
  input, textarea { caret-color: transparent !important; }
`;

// ── Runner ─────────────────────────────────────────────────────────────

const main = async () => {
	mkdirSync(OUT_DIR, { recursive: true });

	// 1. Server: reuse if a healthy instance is already running, else build + start.
	let server: ChildProcess | null = null;
	let startedByUs = false;
	if (await health()) {
		console.log(`Reusing running server at ${BASE}`);
	} else {
		if (DEV) throw new Error(`No server at ${BASE} — start it first (--dev skips build/start).`);
		console.log("Building production bundle…");
		server = spawnServer();
		await new Promise<void>((resolve, reject) => {
			server!.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`bun build exited ${code}`))));
		});
		console.log("Starting server…");
		server = spawn("bun", ["start"], {
			cwd: ROOT,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, TZ: "UTC" },
		});
		server.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
		startedByUs = true;
		await waitForServer(server);
		console.log(`Server healthy at ${BASE}`);
	}

	const cleanup = () => {
		if (startedByUs && !KEEP_SERVER) server?.kill();
	};
	process.on("exit", cleanup);

	// 2. Browser context: fixed, deterministic simulation.
	const browser = await chromium.launch({
		args: ["--force-color-profile=srgb", "--disable-lcd-text", "--font-render-hinting=none"],
	});
	const context = await browser.newContext({
		viewport: { width: VIEWPORT[0], height: VIEWPORT[1] },
		deviceScaleFactor: SCALE,
		locale: "en-US",
		timezoneId: "UTC",
		colorScheme: "light",
		reducedMotion: "reduce",
	});
	await context.addInitScript((css: string) => {
		const style = document.createElement("style");
		style.textContent = css;
		// addInitScript runs before the HTML parser creates <head>/<html>,
		// so attach on DOMContentLoaded (or immediately if we got here late).
		const attach = () => {
			const root = document.head ?? document.documentElement;
			if (root) root.appendChild(style);
		};
		if (document.readyState === "loading") {
			document.addEventListener("DOMContentLoaded", attach, { once: true });
		} else {
			attach();
		}
	}, DETERMINISM_CSS);

	const page = await context.newPage();

	// 3. Guards: page errors, console errors, and >=400 responses fail the run.
	const problems: string[] = [];
	page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => {
		if (msg.type() === "error" && !msg.text().includes("React DevTools")) {
			problems.push(`console.error: ${msg.text()}`);
		}
	});
	page.on("response", (res) => {
		if (res.status() >= 400 && !res.url().includes("favicon.ico")) {
			problems.push(`${res.status()} ${res.request().method()} ${res.url()}`);
		}
	});

	// 4. Capture each state. Navigation resets to the home URL between states
	// so panels never leak across captures; steps re-open what each state needs.
	type ManifestState = {
		name: string;
		file: string;
		activeChatTitle: string;
	};
	const manifest = {
		baseUrl: BASE,
		browser: browser.version(),
		viewport: VIEWPORT,
		deviceScaleFactor: SCALE,
		locale: "en-US",
		timezoneId: "UTC",
		colorScheme: "light",
		reducedMotion: "reduce",
		// SAFETY: states is only appended with ManifestState-shaped records via
		// manifest.states.push below; no other writer mutates the array.
		states: [] as ManifestState[],
	};

	const states = STATES.filter((s) => ONLY.length === 0 || ONLY.includes(s.name));

	for (const state of states) {
		await page.goto(BASE, { waitUntil: "networkidle" });
		await page.evaluate(() => document.fonts.ready);
		for (const step of state.steps) await step(page);
		await state.ready(page);

		const file = `${state.name}.png`;
		await page.screenshot({
			path: join(OUT_DIR, file),
			animations: "disabled",
		});
		const title = await page
			.locator('main[aria-label="Active Chat"] h1')
			.textContent()
			.catch(() => null);
		manifest.states.push({
			name: state.name,
			file,
			activeChatTitle: title ?? "n/a",
		});
		console.log(`✔ ${file}  (chat: ${title ?? "n/a"})`);
	}

	const guard = problems.length > 0 && !ALLOW_ERRORS;
	if (problems.length > 0) {
		console.log(`\n${guard ? "FAILED GUARDS" : "Warnings"}:`);
		for (const p of problems) console.log(`  - ${p}`);
	}

	writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

	await browser.close();
	cleanup();

	if (guard) {
		console.error(`\n✘ ${problems.length} console/network problems — see above.`);
		process.exit(1);
	}
	console.log(`\nDone. ${states.length} screenshots in ${OUT_DIR}`);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
