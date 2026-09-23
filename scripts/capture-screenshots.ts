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
 * - Each surface is stored as a click path and replayed from a fresh load
 *   for each color scheme.
 *
 * Usage:
 *   node scripts/capture-screenshots.ts                        # reuses a server on :3000, else builds + starts one
 *   node scripts/capture-screenshots.ts --base=http://127.0.0.1:5173   # crawl the Vite dev server
 *   node scripts/capture-screenshots.ts --depth=3 --max-states=80 --schemes=dark --viewport=1280x800 --scale=2
 *
 * Output: .scratch/screenshots/states/{index.html,manifest.json,light/,dark/}
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

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

// ── Surface model ──────────────────────────────────────────────────────

type Role = Parameters<Page["getByRole"]>[0];
type Step = { role: Role; name: string; nth: number };
type Surface = { path: Step[]; signature: string; actions: Set<string>; explore: Step[]; problems: string[] };

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

const openSession = async (browser: Browser, colorScheme: "light" | "dark") => {
	const context = await browser.newContext({
		viewport: { width: WIDTH, height: HEIGHT },
		deviceScaleFactor: SCALE,
		locale: "en-US",
		timezoneId: "UTC",
		colorScheme,
		reducedMotion: "reduce",
	});
	await context.addInitScript((css: string) => {
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
	let inflight = 0;
	const tracked = (url: string) => !url.includes("/events");
	page.on("request", (r) => void (tracked(r.url()) && inflight++));
	page.on("requestfinished", (r) => void (tracked(r.url()) && inflight--));
	page.on("requestfailed", (r) => void (tracked(r.url()) && inflight--));
	page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
	page.on("console", (msg) => void (msg.type() === "error" && problems.push(`console.error: ${msg.text()}`)));
	page.on("response", (res) => void (res.status() >= 400 && problems.push(`${res.status()} ${res.request().method()} ${res.url()}`)));

	// Quiet network for 200ms, then two frames for React to commit.
	const settle = async () => {
		for (let quiet = 0, tries = 0; quiet < 2 && tries < 50; tries++) {
			await page.waitForTimeout(100);
			quiet = inflight <= 0 ? quiet + 1 : 0;
		}
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
	};

	const click = async (step: Step) => {
		await page.getByRole(step.role, { name: step.name, exact: true }).nth(step.nth).click({ timeout: 2000 });
		await settle();
	};

	return {
		page,
		click,
		open: async (path: Step[]) => {
			await page.goto(BASE);
			inflight = 0;
			await page.evaluate(() => document.fonts.ready);
			await settle();
			for (const step of path) await click(step);
			blockedWrite = false;
			problems = [];
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

	for (let i = 0; i < surfaces.length && surfaces.length < MAX_STATES; i++) {
		const surface = surfaces[i];
		if (surface.path.length >= MAX_DEPTH) continue;
		for (const step of surface.explore) {
			if (surfaces.length >= MAX_STATES) break;
			const path = [...surface.path, step];
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
			surfaces.push({
				path,
				signature: next.signature,
				actions: new Set(next.actions.map(stepKey)),
				explore: next.actions.filter((a) => !surface.actions.has(stepKey(a))),
				problems: session.takeProblems(),
			});
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

await ensureServer();
const browser = await chromium.launch({
	args: ["--force-color-profile=srgb", "--disable-lcd-text", "--font-render-hinting=none"],
});

const crawler = await openSession(browser, "light");
const surfaces = await crawl(crawler);
await crawler.close();

for (const scheme of SCHEMES) {
	rmSync(join(OUT_DIR, scheme), { recursive: true, force: true });
	mkdirSync(join(OUT_DIR, scheme), { recursive: true });
	const session = await openSession(browser, scheme);
	for (const [index, surface] of surfaces.entries()) {
		try {
			await session.open(surface.path);
			await session.page.screenshot({ path: join(OUT_DIR, scheme, fileOf(index, surface)), animations: "disabled" });
		} catch (error) {
			console.log(`✘ ${scheme} ${describe(surface.path)}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
		}
	}
	await session.close();
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
			surfaces: surfaces.map((s, index) => ({ file: fileOf(index, s), path: describe(s.path), steps: s.path, problems: s.problems })),
		},
		null,
		2,
	),
);
writeFileSync(
	join(OUT_DIR, "index.html"),
	`<!doctype html><meta charset="utf-8"><title>DitzyTavern UI surfaces</title>
<style>body{font:14px system-ui;margin:24px;background:#1b1b1b;color:#ddd}figure{margin:0 0 40px}figcaption{margin-bottom:8px}.shots{display:flex;gap:8px}.shots a{flex:1;min-width:0}.shots img{width:100%;border:1px solid #444}.problems{color:#f88}</style>
${surfaces
	.map(
		(s, index) => `<figure id="${index}"><figcaption>${index} · ${escapeHtml(describe(s.path))}${s.problems.length ? ` <span class="problems">⚠ ${escapeHtml(s.problems.join("; "))}</span>` : ""}</figcaption><div class="shots">${SCHEMES.map(
			(scheme) => `<a href="${scheme}/${fileOf(index, s)}"><img loading="lazy" src="${scheme}/${fileOf(index, s)}"></a>`,
		).join("")}</div></figure>`,
	)
	.join("\n")}`,
);

await browser.close();
const withProblems = surfaces.filter((s) => s.problems.length > 0);
for (const s of withProblems) console.log(`⚠ ${describe(s.path)}\n    ${s.problems.join("\n    ")}`);
console.log(`\nDone. ${surfaces.length} surfaces × ${SCHEMES.length} schemes → ${join(OUT_DIR, "index.html")}`);
process.exit(0);
