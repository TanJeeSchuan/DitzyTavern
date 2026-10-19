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
 * - Each click path gets a fresh seeded SQLite database on the e2e server.
 *   Writes are allowed; model and embedding providers return fixed fixtures.
 * - Each new surface is captured in all requested color schemes in place.
 *   Use --replay to recapture saved click paths without crawling again.
 *
 * Usage:
 *   node scripts/capture-screenshots.ts                        # builds + starts an isolated fixture server
 *   node scripts/capture-screenshots.ts --depth=3 --max-states=80 --schemes=dark --viewport=1280x800 --scale=2
 *   node scripts/capture-screenshots.ts --replay               # recapture the output manifest's paths without discovery
 *   node scripts/capture-screenshots.ts --mobile --viewport=390x844   # touch emulation; audits 40px hit areas and iOS field zoom
 *
 * Output: .scratch/screenshots/states/{index.html,manifest.json,light/,dark/}
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient, startE2eServer } from "../e2e/harness.ts";
import { chromium, type Browser, type Page, type Request } from "@playwright/test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name: string, fallback: string) =>
	process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

let BASE = "";
let captureFailed = false;
const OUT_DIR = join(ROOT, arg("out", ".scratch/screenshots/states"));
const viewport = /^(\d+)x(\d+)$/.exec(arg("viewport", "1440x900"));
if (viewport === null) throw new Error("--viewport must be WIDTHxHEIGHT, such as 1440x900.");
const [WIDTH, HEIGHT] = [Number(viewport[1]), Number(viewport[2])];
const SCALE = Number(arg("scale", "1"));
const MAX_DEPTH = Number(arg("depth", "4"));
const MAX_STATES = Number(arg("max-states", "150"));
const SCHEMES = (["light", "dark"] as const).filter((s) => arg("schemes", "light,dark").split(",").includes(s));
if (SCHEMES.length === 0) throw new Error("Choose at least one color scheme: light or dark.");
const REPLAY = process.argv.includes("--replay");
const MOBILE = process.argv.includes("--mobile");

// ── Geometry audit ─────────────────────────────────────────────────────

/**
 * Runs in the page. Reports elements that widen the page past the viewport,
 * controls whose centre a tap does not reach, hit areas under 24px (40px on
 * touch), and fields under 16px, which iOS zooms into on focus. Hit areas are
 * probed with elementFromPoint, so pseudo-element extensions count.
 */
const audit = (mobile: boolean) => {
	const found: string[] = [];
	const [vw, vh] = [document.documentElement.clientWidth, innerHeight];
	const label = (el: Element) => {
		const name = (el.getAttribute("aria-label") ?? (el instanceof HTMLElement ? el.innerText : "")).trim().replace(/\s+/g, " ").slice(0, 40);
		return `${el.tagName.toLowerCase()}${[...el.classList].slice(0, 2).map((c) => `.${c}`).join("")}${name ? ` "${name}"` : ""}`;
	};
	const shown = (el: Element) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) && !el.closest("[inert], [aria-hidden=true]");
	const outside = (r: DOMRect) => r.right > vw + 1 || r.left < -1;
	const clipped = (el: Element) => {
		for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== "visible") return true;
		return false;
	};
	for (const el of document.body.querySelectorAll("*")) {
		const r = el.getBoundingClientRect();
		if (r.width === 0 || !outside(r) || outside(el.parentElement!.getBoundingClientRect()) || clipped(el) || !shown(el)) continue;
		found.push(`overflow: ${label(el)} spans ${Math.round(r.left)}..${Math.round(r.right)} of ${vw}px`);
	}
	const roles = ["button", "link", "tab", "menuitem", "menuitemradio", "menuitemcheckbox", "checkbox", "switch", "radio", "slider", "option"];
	const targets = ["a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary", ...roles.map((role) => `[role=${role}]`)];
	for (const el of document.querySelectorAll(targets.join(", "))) {
		const r = el.getBoundingClientRect();
		if (r.width < 2 || r.height < 2 || el.matches(":disabled, [aria-disabled=true]") || getComputedStyle(el).display === "inline" || !shown(el)) continue;
		const [cx, cy] = [r.left + r.width / 2, r.top + r.height / 2];
		if (cx < 0 || cy < 0 || cx > vw || cy > vh) continue;
		const owns = (x: number, y: number) => {
			const hit = document.elementFromPoint(x, y);
			return hit !== null && (hit === el || el.contains(hit));
		};
		if (!owns(cx, cy)) {
			const hit = document.elementFromPoint(cx, cy);
			found.push(`covered: ${label(el)} centre lands on ${hit ? label(hit) : "nothing"}`);
			continue;
		}
		const reach = (dx: number, dy: number) => {
			let d = 0;
			while (d < 30 && owns(cx + dx * (d + 1), cy + dy * (d + 1))) d++;
			return d;
		};
		const [w, h] = [reach(-1, 0) + reach(1, 0) + 1, reach(0, -1) + reach(0, 1) + 1];
		if (Math.min(w, h) < (mobile ? 40 : 24)) found.push(`${Math.min(w, h) < 24 ? "small" : "tight"}: ${label(el)} hit area ${w}x${h}`);
	}
	if (mobile) for (const el of document.querySelectorAll("input:not([type=checkbox], [type=radio], [type=range]), textarea, select, [contenteditable=true]")) {
		const size = parseFloat(getComputedStyle(el).fontSize);
		if (size < 16 && shown(el)) found.push(`zoom: ${label(el)} font-size ${size}px`);
	}
	return found;
};

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
		/** @approved NODE always captures the role and the (possibly empty) flags; only the name is optional. */
		const [role, rawName, flags] = [node[1]!, node[2], node[3]!];
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
		isMobile: MOBILE,
		hasTouch: MOBILE,
	});
	await context.addInitScript((css: string) => {
		// Each click path starts with the same preferences, even after exploring Settings.
		localStorage.clear();
		sessionStorage.clear();
		const style = document.createElement("style");
		style.textContent = css;
		document.addEventListener("DOMContentLoaded", () => document.head.appendChild(style), { once: true });
	}, DETERMINISM_CSS);

	let problems: string[] = [];

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
			await page.goto("about:blank");
			await page.emulateMedia({ colorScheme: "light" });
			BASE = await resetServer();
			problems = [];
			inflight.clear();
			await page.goto(BASE);
			await page.evaluate(() => document.fonts.ready);
			await settle();
			for (const step of path) await click(step);
		},
		capture: async (file: string, path: Step[]) => {
			for (const scheme of SCHEMES) {
				try {
					await page.emulateMedia({ colorScheme: scheme });
					await settle();
					await page.screenshot({ path: join(OUT_DIR, scheme, file), animations: "disabled" });
				} catch (error) {
					captureFailed = true;
					problems.push(`screenshot ${scheme}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
					console.log(`✘ ${scheme} ${describe(path)}: ${problems.at(-1)}`);
				}
			}
			problems.push(...(await page.evaluate(audit, MOBILE)));
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
	const home: Surface = { path: [], signature: root.signature, actions: new Set(root.actions.map(stepKey)), explore: root.actions, problems: session.takeProblems() };
	const surfaces = [home];
	const known = new Set([root.signature]);
	await session.capture(fileOf(0, home), []);
	home.problems.push(...session.takeProblems());

	/** @approved The array iterator reads the length on each step, so Surfaces discovered below are explored too. */
	for (const [i, surface] of surfaces.entries()) {
		if (surfaces.length >= MAX_STATES) break;
		if (surface.path.length >= MAX_DEPTH) continue;
		for (const step of surface.explore) {
			if (surfaces.length >= MAX_STATES) break;
			const path = [...surface.path, step];
			console.log(`  Exploring ${i + 1}/${surfaces.length}: ${describe(path)}`);
			try {
				await session.open(surface.path);
				await session.click(step);
				if (!session.page.url().startsWith(BASE)) continue;
				const next = await readSurface(session.page);
				const problems = session.takeProblems();
				if (known.has(next.signature)) {
					surface.problems.push(...problems);
					continue;
				}
				known.add(next.signature);
				const discovered: Surface = {
					path,
					signature: next.signature,
					actions: new Set(next.actions.map(stepKey)),
					explore: next.actions.filter((a) => !surface.actions.has(stepKey(a))),
					problems,
				};
				await session.capture(fileOf(surfaces.length, discovered), path);
				discovered.problems.push(...session.takeProblems());
				surfaces.push(discovered);
				console.log(`✔ ${String(surfaces.length - 1).padStart(3)} ${describe(path)}`);
			} catch (error) {
				captureFailed = true;
				surface.problems.push(...session.takeProblems());
				surface.problems.push(`Could not explore ${describe(path)}: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
				console.log(`✘ ${surface.problems.at(-1)}`);
				continue;
			}
		}
	}
	return surfaces;
};

// ── Server ─────────────────────────────────────────────────────────────

await buildClient();
const server = await startE2eServer();
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));

const resetServer = async () => {
	await server.reset();
	await server.chat({ chunks: ["The door opened. ", "A familiar voice called from the hall."], repeat: true });
	return server.url;
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
				captureFailed = true;
				capture.problems = [...session.takeProblems(), error instanceof Error ? error.message : String(error)];
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
await server.stop();
const withProblems = captures.filter((s) => s.problems.length > 0);
for (const s of withProblems) console.log(`⚠ ${s.path}\n    ${s.problems.join("\n    ")}`);
console.log(`\n${captureFailed ? "Incomplete" : "Done"}. ${captures.length} surfaces × ${SCHEMES.length} schemes → ${join(OUT_DIR, "index.html")}`);
process.exit(captureFailed ? 1 : 0);
