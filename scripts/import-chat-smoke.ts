#!/usr/bin/env node
/**
 * Browser smoke test for the graduated Chat read + Import Details flow.
 *
 * NOTE: run with Node, not Bun — Bun's child_process pipe transport hangs
 * Playwright's Chromium launch (verified: bun times out, node is fine).
 * `node scripts/import-chat-smoke.ts` (Node >= 22.6 with type stripping).
 *
 * The smoke drives the real application against a production build on a
 * fresh scratch database in .playwright-cli/ (arms: seeded Characters and
 * Conversations, then a full Import Chat flow), exactly like the
 * deterministic screenshot capture:
 *   - production build + deterministic server launch on an isolated temp root
 *   - pinned browser build + fixed viewport / locale / timezone / scheme
 *   - reducedMotion + forced sRGB + determinism CSS injection
 *   - semantic locator waits, never sleeps
 *   - strict network/console guard (>=400 responses fail the run)
 *
 * It verifies, in desktop and narrow panel layouts:
 *   1. a completed import commits and opens the Chat immediately,
 *   2. graduated reading: native Messages render with resolved Author Stamps,
 *   3. swipe selection persists positions including the exact empty
 *      alternative's presentation-only placeholder,
 *   4. Chat information exposes Import Details only when provenance exists,
 *   5. Download preserved source streams the exact uploaded bytes with the
 *      stored original leaf filename.
 *
 * Usage:
 *   node scripts/import-chat-smoke.ts                # build + fresh scratch + serve + run
 *   node scripts/import-chat-smoke.ts --dev          # reuse a running server (no build, no seed)
 *   node scripts/import-chat-smoke.ts --keep-server
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
	mkdirSync,
	readFileSync,
	cpSync,
	rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH_ROOT = join(ROOT, ".playwright-cli");

const arg = (name: string, fallback?: string) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? hit.slice(name.length + 3) : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const BASE = arg("base", process.env.BASE_URL ?? "http://127.0.0.1:3000");
const DEV = flag("dev");
const KEEP_SERVER = flag("keep-server");

// ── Synthetic export fixtures ───────────────────────────────────────────

const headerFixture = {
	chat_metadata: { integrity: "smoke-integrity-0001" },
	user_name: "TANJS",
	character_name: "Rulership",
};

const jsonl = (records: unknown[]) =>
	records.map((record) => JSON.stringify(record)).join("\n");

const writerRecord = (index: number) => ({
	name: "Writer",
	is_user: true,
	send_date: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
	mes: `Guidance ${index}: the lantern house waits.`,
});

const partnerRecord = (index: number) => ({
	name: "Rulership",
	is_user: false,
	send_date: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
	mes: `Rulership answers ${index} with measured prose.`,
});

// One record with a source-selected Swipe, a duplicate alternative, and an
// exact empty alternative — the graduated reading model must keep all three
// positions and render the empty one with a presentation-only placeholder.
const swipeRecord = {
	name: "Rulership",
	is_user: false,
	send_date: "2026-08-08T13:04:55.256Z",
	mes: "Second alternative, still saved",
	swipes: [
		"First alternative text",
		"Second alternative, still saved",
		"",
	],
	swipe_id: 1,
	swipe_info: [
		{ send_date: "2026-08-08T13:04:50.000Z" },
		{ send_date: "2026-08-08T13:04:55.256Z" },
		{ send_date: "2026-08-08T13:05:00.000Z" },
	],
};

// Enough records to cross one default history page (50 Messages), so the
// story shows the Load-more control after the Chat opens.
const buildFixture = (seed: string) => {
	const records: unknown[] = [
		{ ...headerFixture, chat_metadata: { integrity: `smoke-${seed}` } },
		writerRecord(1),
		swipeRecord,
	];
	for (let index = 3; index <= 60; index += 1) {
		records.push(
			index % 2 === 0
				? partnerRecord(index)
				: writerRecord(index),
		);
	}
	return Buffer.from(jsonl(records), "utf8");
};

// ── Server lifecycle (isolated scratch root) ────────────────────────────

const health = async (): Promise<boolean> => {
	try {
		const res = await fetch(`${BASE}/api/health`);
		return res.status === 200;
	} catch {
		return false;
	}
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForServer = async (timeoutMs = 90_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await health()) return;
		await sleep(500);
	}
	throw new Error(`Server did not become healthy at ${BASE} within ${timeoutMs}ms.`);
};

interface ServerHandle {
	tempRoot: string | null;
	child: ChildProcess | null;
	startedByUs: boolean;
}

const bringUpServer = async (): Promise<ServerHandle> => {
	// Only an explicit --dev may reuse a running server: the smoke must run
	// against the freshly built client and a seeded scratch database, never
	// whatever a leftover dev server happens to serve.
	if (DEV) {
		if (await health()) {
			console.log(`Reusing running server at ${BASE} (--dev)`);
			return { tempRoot: null, child: null, startedByUs: false };
		}
		throw new Error(`No server at ${BASE} — start one first (--dev).`);
	}
	if (await health()) {
		throw new Error(
			`A server is already listening at ${BASE}. Stop it (or pass --dev to reuse it) so the smoke can run hermetically.`,
		);
	}

	console.log("Building production bundle…");
	const build = spawn("bun", ["run", "build"], {
		cwd: ROOT,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, TZ: "UTC" },
	});
	const buildCode = await new Promise<number>((resolve, reject) => {
		build.on("exit", (code) => resolve(code ?? 1));
		build.on("error", reject);
	});
	if (buildCode !== 0) throw new Error(`bun run build exited ${buildCode}`);

	// A fresh scratch root mirrors the deployment layout the server derives
	// from its working directory: dist/, data/ditzytavern.sqlite, and the
	// managed artifact directory under data/.
	mkdirSync(SCRATCH_ROOT, { recursive: true });
	const tempRoot = join(SCRATCH_ROOT, `smoke-${Date.now()}`);
	mkdirSync(join(tempRoot, "dist"), { recursive: true });
	cpSync(join(ROOT, "dist"), join(tempRoot, "dist"), { recursive: true });

	// Seed the scratch database (migrations run on open) so the workspace
	// starts with Characters and Chats, exactly like a seeded dev database.
	const seed = spawn("bun", [join(ROOT, "src/server/database/seed.ts")], {
		cwd: tempRoot,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, TZ: "UTC" },
	});
	const seedCode = await new Promise<number>((resolve, reject) => {
		seed.on("exit", (code) => resolve(code ?? 1));
		seed.on("error", reject);
	});
	if (seedCode !== 0) throw new Error(`db seed exited ${seedCode}`);

	console.log(`Starting server on scratch root ${tempRoot}…`);
	const child = spawn("bun", [join(ROOT, "src/server/index.ts")], {
		cwd: tempRoot,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, TZ: "UTC" },
	});
	child.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
	await waitForServer();
	return { tempRoot, child, startedByUs: true };
};

// ── Determinism setup ───────────────────────────────────────────────────

const DETERMINISM_CSS = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    scroll-behavior: auto !important;
  }
  input, textarea { caret-color: transparent !important; }
`;

// ── Shared UI helpers ───────────────────────────────────────────────────

const rail = (page: any, label: string) =>
	page
		.locator('nav[aria-label="Workspace"]')
		.getByRole("button", { name: label, exact: true });

const storyTitle = (page: any) =>
	page.locator('main[aria-label="Active Chat"] h1');

// Runs one full import scenario: uploads the fixture through the Chats panel
// flow, commits it, opens the Chat, and verifies graduated reading, swipe
// selection (including the empty placeholder), Chat information -> Import
// Details, and the exact download when `verifyDownload` is set.
const runImportScenario = async (
	page: any,
	scenario: { title: string; filename: string; fixture: Buffer; verifyDownload: boolean },
) => {
	console.log(`\n=== Scenario: ${scenario.title} ===`);

	// 1. Open the import flow from the Chats primary panel.
	await page.goto(BASE, { waitUntil: "networkidle" });
	await page.evaluate(() => document.fonts.ready);
	await rail(page, "Chats").click();
	await page.getByRole("heading", { name: "Chats", exact: true }).waitFor();
	await page.getByRole("button", { name: "Import Chat", exact: true }).click();
	// The choose control's accessible name carries its helper line, so match
	// the leading label text instead of the full name.
	await page
		.getByRole("button", { name: /Choose a SillyTavern export/ })
		.waitFor();

	await page.setInputFiles('input[type="file"]', {
		name: scenario.filename,
		mimeType: "application/jsonl",
		buffer: scenario.fixture,
	});
	await page
		.getByRole("heading", { name: "Import Chat" })
		.waitFor();
	await page.getByText("Resolve Participants", { exact: true }).waitFor();

	// The filename-derived title is editable; set the intended Chat title.
	await page.getByPlaceholder("Title this Chat").fill(scenario.title);

	// 3. Resolution defaults are complete (two chat-only Participants named
	//    from the exact captured author strings); continue to the final
	//    review and commit.
	await page
		.getByRole("button", { name: "Continue to review", exact: true })
		.click();
	await page
		.getByRole("heading", { name: "Review import", exact: true })
		.waitFor();
	await page
		.getByRole("button", { name: "Import this Chat", exact: true })
		.click();
	await page.getByText("Chat imported", { exact: true }).waitFor();

	// The compact success receipt confirms what was created.
	await page.getByText(scenario.filename).first().waitFor();

	// 4. Open the imported Chat immediately.
	await page.getByRole("button", { name: "Open Chat", exact: true }).click();
	await storyTitle(page)
		.getByText(scenario.title, { exact: true })
		.waitFor({ timeout: 20_000 })
		.catch(async (error: Error) => {
			const h1 = await page.locator('main[aria-label="Active Chat"] h1').textContent().catch(() => null);
			const chats = await page
				.locator(".chat-list-item span")
				.allTextContents()
				.catch(() => []);
			const alerts = await page.locator("[role=alert]").allInnerTexts().catch(() => []);
			console.error(`[diag] h1=${JSON.stringify(h1)}`);
			console.error(`[diag] chats=${JSON.stringify(chats)}`);
			console.error(`[diag] alerts=${JSON.stringify(alerts)}`);
			throw error;
		});
	// Graduated reading: the story renders native Messages with resolved
	// Author Stamps through the paginated read model.
	await page.locator(".story-message").first().waitFor();
	const authors = await page.locator(".story-message .message-author strong").allTextContents();
	if (!authors.includes("Writer")) {
		throw new Error(`${scenario.title}: resolved Author Stamp "Writer" not rendered (got ${JSON.stringify(authors.slice(0, 4))})`);
	}
	if (!authors.includes("Rulership")) {
		throw new Error(`${scenario.title}: resolved Author Stamp "Rulership" not rendered`);
	}

	const loadMore = page.getByRole("button", { name: "Load more Messages", exact: true });
	await loadMore.click();
	await page.getByText("Guidance 1: the lantern house waits.", { exact: true }).waitFor();

	// The source-selected Swipe initialized the native selection: the swipe
	// record shows "Second alternative, still saved" first (swipe_id 1).
	// Once the active Variant changes, the message's text changes, so the
	// message is anchored by its stable data-message-id attribute.
	const initialSwipe = page
		.locator(".story-message")
		.filter({ hasText: "Second alternative, still saved" })
		.first();
	await initialSwipe.waitFor();
	const messageId = await initialSwipe.getAttribute("data-message-id");
	if (messageId === null) {
		throw new Error(`${scenario.title}: swipe message has no data-message-id`);
	}
	const swipeMessage = page.locator(`.story-message[data-message-id="${messageId}"]`);
	await swipeMessage.getByText("2 of 3", { exact: true }).waitFor();
	await swipeMessage
		.getByText("Second alternative, still saved", { exact: true })
		.first()
		.waitFor();

	// 5. Swipe navigation: Next exposes the exact empty alternative through
	//    the presentation-only placeholder, and duplicate/empty positions
	//    stay separate navigable states.
	await swipeMessage
		.getByRole("button", { name: "Next Swipe", exact: true })
		.click();
	await swipeMessage.getByText("3 of 3", { exact: true }).waitFor();
	await swipeMessage.getByText("(empty alternative)", { exact: true }).waitFor();
	await swipeMessage
		.getByRole("button", { name: "Previous Swipe", exact: true })
		.click();
	await swipeMessage.getByText("2 of 3", { exact: true }).waitFor();

	// 7. Chat information conditionally exposes Import Details.
	await page
		.getByRole("button", { name: "Chat information", exact: true })
		.click();
	await page
		.getByRole("heading", { name: "Chat information", exact: true })
		.waitFor();
	await page
		.getByRole("heading", { name: "Import Details", exact: true })
		.waitFor();
	await page.getByText(scenario.filename, { exact: true }).first().waitFor();
	await page
		.getByRole("button", { name: "Download preserved source", exact: true })
		.waitFor();

	// 8. Exact download: the stored original leaf filename and the exact
	//    bytes arrive verbatim.
	if (scenario.verifyDownload) {
		const downloadPromise = page.waitForEvent("download");
		await page
			.getByRole("button", { name: "Download preserved source", exact: true })
			.click();
		const download = await downloadPromise;
		if (download.suggestedFilename() !== scenario.filename) {
			throw new Error(
				`download filename mismatch: ${download.suggestedFilename()} !== ${scenario.filename}`,
			);
		}
		const path = await download.path();
		if (path === null) throw new Error("download produced no local path");
		const bytes = readFileSync(path);
		if (bytes.length !== scenario.fixture.length || !bytes.equals(scenario.fixture)) {
			throw new Error(
				`download bytes differ from the uploaded fixture (${bytes.length} vs ${scenario.fixture.length})`,
			);
		}
		console.log(`✔ exact download verified (${bytes.length} bytes, sha matches)`);
	}
};

// ── Runner ──────────────────────────────────────────────────────────────

const main = async () => {
	const server = await bringUpServer();
	const stopServer = async () => {
		if (server.startedByUs && !KEEP_SERVER && server.child !== null) {
			server.child.kill();
			await new Promise<void>((resolve) => {
				server.child?.once("exit", () => resolve());
			});
		}
	};
	// Sync guard for process exit paths; the main flow awaits stopServer so a
	// running child cannot hold the scratch root open when it is removed.
	process.on("exit", () => {
		if (server.startedByUs && !KEEP_SERVER) server.child?.kill();
	});

	const browser = await chromium.launch({
		args: ["--force-color-profile=srgb", "--disable-lcd-text", "--font-render-hinting=none"],
	});

	// Desktop scenario.
	const desktopContext = await browser.newContext({
		viewport: { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		locale: "en-US",
		timezoneId: "UTC",
		colorScheme: "light",
		reducedMotion: "reduce",
	});
	await desktopContext.addInitScript((css: string) => {
		const style = document.createElement("style");
		style.textContent = css;
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
	const desktopPage = await desktopContext.newPage();
	const desktopProblems: string[] = [];
	watchPage(desktopPage, desktopProblems);
	await runImportScenario(desktopPage, {
		title: "Lantern House Smoke",
		filename: "smoke-desktop.jsonl",
		fixture: buildFixture("desktop"),
		verifyDownload: true,
	});
	if (desktopProblems.length > 0) {
		throw new Error(`desktop guards failed:\n${desktopProblems.join("\n")}`);
	}
	await desktopContext.close();

	// Narrow panel layout: the panels become full-screen nested layers with
	// the same flow and reading surfaces.
	const narrowContext = await browser.newContext({
		viewport: { width: 420, height: 820 },
		deviceScaleFactor: 1,
		locale: "en-US",
		timezoneId: "UTC",
		colorScheme: "light",
		reducedMotion: "reduce",
	});
	await narrowContext.addInitScript((css: string) => {
		const style = document.createElement("style");
		style.textContent = css;
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
	const narrowPage = await narrowContext.newPage();
	const narrowProblems: string[] = [];
	watchPage(narrowPage, narrowProblems);
	await runImportScenario(narrowPage, {
		title: "Narrow Desk Smoke",
		filename: "smoke-narrow.jsonl",
		fixture: buildFixture("narrow"),
		verifyDownload: false,
	});
	if (narrowProblems.length > 0) {
		throw new Error(`narrow guards failed:\n${narrowProblems.join("\n")}`);
	}
	await narrowContext.close();

	await browser.close();
	await stopServer();

	// Keep the scratch root only when the server is kept for inspection.
	if (!KEEP_SERVER && server.tempRoot !== null) {
		rmSync(server.tempRoot, { recursive: true, force: true });
	}
	console.log("\n✔ Import Chat smoke passed: desktop and narrow flows verified.");
};

// Strict guards: any page error or >=400 response fails the run unless it is
// the download route carrying the exact artifact (which is a 200 anyway).
const watchPage = (page: any, problems: string[]) => {
	page.on("pageerror", (err: Error) => problems.push(`pageerror: ${err.message}`));
	page.on("console", (msg: any) => {
		if (msg.type() === "error" && !msg.text().includes("React DevTools")) {
			problems.push(`console.error: ${msg.text()}`);
		}
	});
	page.on("response", (res: any) => {
		if (res.status() >= 400 && !res.url().includes("favicon.ico")) {
			problems.push(`${res.status()} ${res.request().method()} ${res.url()}`);
		}
	});
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
