#!/usr/bin/env node
/**
 * Crawls DitzyTavern's UI surfaces (panels, dialogs, menus) and screenshots
 * each distinct one in light and dark, for visual auditing.
 *
 * NOTE: run with Node, not Bun — Bun's child_process pipe transport hangs
 * Playwright's Chromium launch.
 *
 * - Breadth-first from the home screen, clicking buttons, tabs and menu items.
 *   From each new surface only the controls it introduced are explored, once
 *   per label, and list rows are sampled by their first row, so data volume
 *   never multiplies shots.
 * - A surface is identified by its dialogs, menus, landmarks, form-control
 *   labels and toggle states, never by text or button labels (which carry
 *   data): one character editor is one surface, whichever character is open.
 * - Every non-GET API request is aborted, so the crawl never writes to the
 *   database; clicks that attempt a write are skipped.
 * - Each new surface is captured in all requested color schemes in place.
 *   Use --replay to recapture saved click paths without crawling again.
 *
 * Usage:
 *   node scripts/capture-screenshots.ts                        # reuses a server on :3000, else builds + starts one
 *   node scripts/capture-screenshots.ts --base=http://127.0.0.1:5173   # crawl the Vite dev server
 *   node scripts/capture-screenshots.ts --depth=3 --max-states=80 --schemes=dark --viewport=1280x800 --scale=2
 *   node scripts/capture-screenshots.ts --replay               # recapture the output manifest's paths without discovery
 *
 * Output: .scratch/screenshots/states/{index.html,manifest.json,light/,dark/}
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page, type Request } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name: string, fallback: string) =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const BASE = arg("base", "http://127.0.0.1:3000");
const OUT_DIR = join(ROOT, arg("out", ".scratch/screenshots/states"));
const [WIDTH, HEIGHT] = arg("viewport", "1440x900").split("x").map(Number);
const SCALE = Number(arg("scale", "1"));
const MAX_DEPTH = Number(arg("depth", "4"));
const MAX_STATES = Number(arg("max-states", "150"));
const SCHEMES = (["light", "dark"] as const).filter((s) => arg("schemes", "light,dark").split(",").includes(s));
const REPLAY = process.argv.includes("--replay");

// ── Surface model ──────────────────────────────────────────────────────

type Role = Parameters<Page["getByRole"]>[0];
type Step = { role: Role; name: string; nth: number };
type Surface = { path: Step[]; signature: string; actions: Set<string>; explore: Step[]; problems: string[] };
type Capture = { file: string; path: string; steps: Step[]; problems: string[] };

const ACTION_ROLES = ["button", "tab", "menuitem", "menuitemradio", "menuitemcheckbox"] as const satisfies Role[];
const CONTEXT_ROLES = [
	"dialog", "alertdialog", "menu", "listbox", "tablist", "region", "navigation", "main",
	"complementary", "form", "textbox", "searchbox", "combobox", "checkbox", "switch",
	"slider", "spinbutton", "radio",
];
// Their names are message text, so only presence distinguishes a surface.
const NAMELESS_ROLES = ["alert", "status"];
const SIGNATURE_FLAGS = /\[(?:pressed|selected|expanded)\]/g;
// POSTs that compute without persisting.
const READ_ONLY_POSTS = [/\/generations\/preview$/, /\/lorebooks\/match-test$/];

// ariaSnapshot lines look like `- button "Name" [pressed]`, but YAML-quote the
// whole key when the name contains YAML syntax.
const NODE = /^([a-z]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]+\])*)/;

const closingQuote = (text: string) => {
	for (let i = 1; i < text.length; i++) {
		if (text[0] === '"' && text[i] === "\\") i++;
		else if (text[i] === text[0] && text[i + 1] === "'" && text[0] === "'") i++;
		else if (text[i] === text[0]) return i;
	}
	return text.length;
};

const unquoteKey = (text: string): string => {
	if (text[0] !== "'" && text[0] !== '"') return text;
	const quoted = text.slice(0, closingQuote(text) + 1);
	return text[0] === '"' ? JSON.parse(quoted) : quoted.slice(1, -1).replaceAll("''", "'");
};

const readSurface = async (page: Page) => {
	const snapshot = await page.locator("body").ariaSnapshot();
	const counts = new Map<string, number>();
	const signature = new Set<string>();
	const actions: Step[] = [];
	const listItemIndents: number[] = [];
	let skipDeeperThan = Infinity;

	for (const line of snapshot.split("\n")) {
		const indent = line.indexOf("- ");
		const node = unquoteKey(line.slice(indent + 2)).match(NODE);
		if (indent < 0 || !node) continue;
		const [, role, rawName, flags] = node;
		const name: string = rawName === undefined ? "" : JSON.parse(`"${rawName}"`);
		const key = `${role} "${name}"`;
		const nth = counts.get(key) ?? 0;
		counts.set(key, nth + 1);

		// Sample lists by their first row only.
		if (indent > skipDeeperThan) continue;
		skipDeeperThan = Infinity;
		while ((listItemIndents.at(-1) ?? -1) > indent) listItemIndents.pop();
		if (role === "listitem") {
			if (listItemIndents.at(-1) === indent) {
				skipDeeperThan = indent;
				continue;
			}
			listItemIndents.push(indent);
		}

		const actionRole = ACTION_ROLES.find((r) => r === role);
		const toggles = (flags.match(SIGNATURE_FLAGS) ?? []).join("");
		if (NAMELESS_ROLES.includes(role)) signature.add(role);
		else if (CONTEXT_ROLES.includes(role) || (actionRole && toggles)) signature.add(key + toggles);
		if (actionRole && name && nth === 0 && !flags.includes("[disabled]")) actions.push({ role: actionRole, name, nth });
	}
	return { signature: [...signature].sort().join("\n"), actions };
};

const stepKey = (step: Step) => `${step.role} "${step.name}"`;
const describe = (path: Step[]) =>
	path.map((s) => (s.nth > 0 ? `${s.name} #${s.nth + 1}` : s.name)).join(" › ") || "Home";
const fileOf = (index: number, surface: Surface) =>
	`${String(index).padStart(3, "0")}-${describe(surface.path).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80)}.png`;

// ── Browser session ────────────────────────────────────────────────────

const DETERMINISM_CSS = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    scroll-behavior: auto !important;
  }
  input, textarea { caret-color: transparent !important; }
`;

const openSession = async (browser: Browser) => {
	const context = await browser.newContext({
		viewport: { width: WIDTH, height: HEIGHT },
		deviceScaleFactor: SCALE,
		locale: "en-US",
		timezoneId: "UTC",
		colorScheme: "light",
		reducedMotion: "reduce",
	});
	await context.addInitScript((css: string) => {
		// Each click path starts with the same preferences, even after exploring Settings.
		localStorage.clear();
		sessionStorage.clear();
		const style = document.createElement("style");
		style.textContent = css;
		document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style), { once: true });
	}, DETERMINISM_CSS);

	let blockedWrite = false;
	let problems: string[] = [];
	await context.route(`${BASE}/api/**`, (route) => {
		const request = route.request();
		if (request.method() === "GET" || READ_ONLY_POSTS.some((p) => p.test(new URL(request.url()).pathname))) {
			return route.continue();
		}
		blockedWrite = true;
		return route.abort("blockedbyclient");
	});

	const page = await context.newPage();
	const inflight = new Set<Request>();
	let requestsStarted = 0;
	const tracked = (url: string) => !url.includes("/events");
	page.on("request", (r) => {
		if (!tracked(r.url())) return;
		inflight.add(r);
		requestsStarted++;
	});
	page.on("requestfinished", (r) => inflight.delete(r));
	page.on("requestfailed", (r) => inflight.delete(r));
	page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => void (msg.type() === "error" && problems.push(`console.error: ${msg.text()}`)));
	page.on("response", (res) => void (res.status() >= 400 && problems.push(`${res.status()} ${res.request().method()} ${res.url()}`)));

	// Wait for pending requests and two frames without new requests for React to commit.
	const settle = async () => {
		for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
			const started = requestsStarted;
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
			if (inflight.size === 0 && requestsStarted === started) return;
		}
		throw new Error(`Page did not settle within 5 seconds (${[...inflight].map((r) => r.url()).join(", ")})`);
	};

	const click = async (step: Step) => {
		await page.getByRole(step.role, { name: step.name, exact: true }).nth(step.nth).click({ timeout: 2000 });
		await settle();
	};

	return {
		page,
		click,
		open: async (path: Step[]) => {
			blockedWrite = false;
			problems = [];
			inflight.clear();
			await page.goto(BASE);
			await page.evaluate(() => document.fonts.ready);
			await settle();
			for (const step of path) await click(step);
			blockedWrite = false;
		},
		capture: async (file: string, path: Step[]) => {
			try {
				for (const scheme of SCHEMES) {
					try {
						await page.emulateMedia({ colorScheme: scheme });
						await settle();
						await page.screenshot({ path: join(OUT_DIR, scheme, file), animations: "disabled" });
					} catch (error) {
						problems.push(`screenshot ${scheme}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
						console.log(`✘ ${scheme} ${describe(path)}: ${problems.at(-1)}`);
					}
				}
			} finally {
				await page.emulateMedia({ colorScheme: "light" });
				await settle();
			}
		},
		takeBlockedWrite: () => {
			const blocked = blockedWrite;
			blockedWrite = false;
			return blocked;
		},
		takeProblems: () => {
			const taken = problems;
			problems = [];
			return taken;
		},
		close: () => context.close(),
	};
};

type Session = Awaited<ReturnType<typeof openSession>>;

// ── Crawl ──────────────────────────────────────────────────────────────

const crawl = async (session: Session) => {
	await session.open([]);
	const root = await readSurface(session.page);
	const surfaces: Surface[] = [
		{ path: [], signature: root.signature, actions: new Set(root.actions.map(stepKey)), explore: root.actions, problems: session.takeProblems() },
	];
	const known = new Set([root.signature]);
	let at: Surface | undefined = surfaces[0];
	await session.capture(fileOf(0, surfaces[0]), []);
	surfaces[0].problems.push(...session.takeProblems());

	for (let i = 0; i < surfaces.length && surfaces.length < MAX_STATES; i++) {
		const surface = surfaces[i];
		if (surface.path.length >= MAX_DEPTH) continue;
		for (const step of surface.explore) {
			if (surfaces.length >= MAX_STATES) break;
			const path = [...surface.path, step];
			console.log(`  Exploring ${i + 1}/${surfaces.length}: ${describe(path)}`);
			try {
				if (at !== surface) await session.open(surface.path);
				at = undefined;
				await session.click(step);
			} catch {
				console.log(`  · skipped ${describe(path)} (not clickable)`);
				continue;
			}
			if (session.takeBlockedWrite()) {
				console.log(`  · skipped ${describe(path)} (writes)`);
				continue;
			}
			if (!session.page.url().startsWith(BASE)) continue;
			const next = await readSurface(session.page);
			if (known.has(next.signature)) continue;
			known.add(next.signature);
			const discovered: Surface = {
				path,
				signature: next.signature,
				actions: new Set(next.actions.map(stepKey)),
				explore: next.actions.filter((a) => !surface.actions.has(stepKey(a))),
				problems: session.takeProblems(),
			};
			await session.capture(fileOf(surfaces.length, discovered), path);
			discovered.problems.push(...session.takeProblems());
			surfaces.push(discovered);
			console.log(`✔ ${String(surfaces.length - 1).padStart(3)} ${describe(path)}`);
		}
	}
	return surfaces;
};

// ── Server ─────────────────────────────────────────────────────────────

const healthy = () => fetch(`${BASE}/api/health`).then((r) => r.ok, () => false);

const run = (command: string, args: string[]) =>
	new Promise<void>((resolve, reject) =>
		spawn(command, args, { cwd: ROOT, stdio: "inherit" }).on("exit", (code) =>
			code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`)),
		),
	);

const ensureServer = async () => {
	if (await healthy()) {
		console.log(`Reusing running server at ${BASE}`);
		return;
	}
	await run("bun", ["run", "build"]);
	const server: ChildProcess = spawn("bun", ["start"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
	process.on("exit", () => server.kill());
	for (const deadline = Date.now() + 60_000; !(await healthy()); ) {
		if (Date.now() > deadline || server.exitCode !== null) throw new Error(`Server did not become healthy at ${BASE}`);
		await new Promise((r) => setTimeout(r, 500));
	}
};

// ── Main ───────────────────────────────────────────────────────────────

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const saved: { surfaces: Capture[] } | undefined = REPLAY
	? JSON.parse(readFileSync(join(OUT_DIR, "manifest.json"), "utf8"))
	: undefined;
for (const scheme of SCHEMES) {
	rmSync(join(OUT_DIR, scheme), { recursive: true, force: true });
	mkdirSync(join(OUT_DIR, scheme), { recursive: true });
}

await ensureServer();
const browser = await chromium.launch({
	args: ["--force-color-profile=srgb", "--disable-lcd-text", "--font-render-hinting=none"],
});

let captures: Capture[];
if (saved) {
	captures = saved.surfaces;
	const session = await openSession(browser);
	try {
		for (const capture of captures) {
			try {
				await session.open(capture.steps);
				await session.capture(capture.file, capture.steps);
				capture.problems = session.takeProblems();
			} catch (error) {
				capture.problems = [error instanceof Error ? error.message : String(error)];
				console.log(`✘ ${capture.path}: ${capture.problems[0]}`);
			}
		}
	} finally {
		await session.close();
	}
} else {
	const crawler = await openSession(browser);
	const surfaces = await crawl(crawler);
	await crawler.close();
	captures = surfaces.map((s, index) => ({ file: fileOf(index, s), path: describe(s.path), steps: s.path, problems: s.problems }));
}

writeFileSync(
	join(OUT_DIR, "manifest.json"),
	JSON.stringify(
		{
			baseUrl: BASE,
			browser: browser.version(),
			viewport: [WIDTH, HEIGHT],
			deviceScaleFactor: SCALE,
			schemes: SCHEMES,
			surfaces: captures,
		},
		null,
		2,
	),
);
writeFileSync(
	join(OUT_DIR, "index.html"),
	`<!doctype html><meta charset="utf-8"><title>DitzyTavern UI surfaces</title>
<style>body{font:14px system-ui;margin:24px;background:#1b1b1b;color:#ddd}figure{margin:0 0 40px}figcaption{margin-bottom:8px}.shots{display:flex;gap:8px}.shots a{flex:1;min-width:0}.shots img{width:100%;border:1px solid #444}.problems{color:#f88}</style>
${captures
	.map(
		(s, index) => `<figure id="${index}"><figcaption>${index} · ${escapeHtml(s.path)}${s.problems.length ? ` <span class="problems">⚠ ${escapeHtml(s.problems.join("; "))}</span>` : ""}</figcaption><div class="shots">${SCHEMES.map(
			(scheme) => `<a href="${scheme}/${s.file}"><img loading="lazy" src="${scheme}/${s.file}"></a>`,
		).join("")}</div></figure>`,
	)
	.join("\n")}`,
);

await browser.close();
const withProblems = captures.filter((s) => s.problems.length > 0);
for (const s of withProblems) console.log(`⚠ ${s.path}\n    ${s.problems.join("\n    ")}`);
console.log(`\nDone. ${captures.length} surfaces × ${SCHEMES.length} schemes → ${join(OUT_DIR, "index.html")}`);
process.exit(0);
