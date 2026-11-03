import type { Request } from "@playwright/test";
import { test, expect, insertBox } from "./fixtures";

// The frame's policy refuses every escape the probe tries, and the browser logs each refusal; a restart cuts the open change stream.
test.use({ allowedBrowserErrors: /Content Security Policy|ERR_BLOCKED_BY_CSP|ERR_INCOMPLETE_CHUNKED_ENCODING|WebSocket connection/ });

test("a sandboxed Box's UI reaches no network, navigates nothing, and ignores a port it was not handed", async ({ page, llm, request, baseURL }) => {
	await llm.installBox("escape-probe");
	await llm.restart("graceful");
	await page.goto("/");
	await insertBox(page, "Escape Probe");
	const app = new URL(baseURL!).origin; // @approved The fixture's server always sets a baseURL.
	const other = app.replace("127.0.0.1", "localhost");
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const { revision } = await (await request.get(`/api/conversations/${activeChatId}`)).json();
	const setup = { app, other, round: 1 };
	expect((await request.post(`/api/conversations/${activeChatId}/commands`, { data: { expectedRevision: revision, action: { type: "set-box-setup", box: "escape-probe", setup } } })).ok()).toBe(true);
	await page.getByRole("button", { name: "Escape Probe", exact: true }).click();
	const frame = page.getByRole("dialog", { name: "Escape Probe" }).frameLocator("iframe");
	const escapes = frame.getByRole("status", { name: "Escapes" });
	await expect(escapes).toContainText('["WebTransport","undefined"],["RTCPeerConnection","undefined"],["webkitRTCPeerConnection","undefined"]', { timeout: 30_000 });

	const appPage = page.url();
	for (const element of await frame.locator("body *").all()) await element.click({ force: true, timeout: 500 }).catch(() => undefined);
	const frameDocument = page.frames().find((candidate) => candidate.url().includes("/api/box-frame/"));
	expect(frameDocument).toBeDefined();

	// The recorder sees a request from outside the sandbox, so its silence about the probe's own means none got through.
	await request.get(`${other}/sandbox-escape-control`);
	await expect.poll(async () => (await llm.log()).probes).toEqual([`${other}/sandbox-escape-control`]);
	expect(page.url()).toBe(appPage);
	expect(frameDocument?.url()).toMatch(new RegExp(`^${app}/api/box-frame/[A-Za-z0-9_-]{24}$`));

	// A port the frame accepted would deliver this read before the Ping click reaches the guest, so Round would show 99 by the time the next Ping shows.
	await page.evaluate(() => {
		const { port1, port2 } = new MessageChannel();
		document.querySelector<HTMLIFrameElement>("iframe.box-frame")?.contentWindow?.postMessage(null, "*", [port2]);
		port1.postMessage({ type: "read", read: { setup: { app: "", other: "", round: 99 }, images: [] }, view: { moves: null, disabled: false, stale: false, snapshot: 0 } });
	});
	const pings = frame.getByRole("status", { name: "Pings" });
	const before = Number(await pings.textContent());
	await frame.getByRole("button", { name: "Ping" }).click();
	await expect(pings).toHaveText(String(before + 1));
	await expect(frame.getByRole("status", { name: "Round" })).toHaveText("1");
});

const png = (base64: string) => ({ name: "image.png", mimeType: "image/png", buffer: Buffer.from(base64, "base64") });
const ownImage = png("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1EAAAAASUVORK5CYII=");
const otherImage = png("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==");

// @approved
//  The host decides what a frame may display: the Image the Box uploaded
// through its frame shows on every surface, while an Image it does not own,
// even with its hash written into the Box's own Library values, loads on
// none of them, and the app's own image route is never asked. The server
// refuses such an Image with a JSON 404, whose body the browser's Opaque
// Response Blocking then drops for the opaque-origin frame, so a refused
// surface reports a failed request rather than a response.
test.describe("a sandboxed Box's images", () => {
	test.use({ allowedBrowserErrors: /Content Security Policy|ERR_BLOCKED_BY_CSP|status of 404/ });

	test("its frame displays the Image it uploaded and no Image it does not own, on every image surface", async ({ page, llm, request }) => {
		await llm.installBox("escape-probe");
		await llm.restart("graceful");
		await page.goto("/");
		await insertBox(page, "Escape Probe");
		const { hash: forged } = await (await request.post("/api/images", { data: { data: otherImage.buffer.toString("base64") } })).json();
		const { activeChatId } = await (await request.get("/api/workspace")).json();
		const { revision } = await (await request.get(`/api/conversations/${activeChatId}`)).json();
		const library = { type: "library" } as const;
		const commit = { type: "commit-box", box: "escape-probe", writes: [{ owner: library, key: "image:forged", value: forged }], expected: [{ owner: library, key: "image:forged", revision: 0 }] };
		expect((await request.post(`/api/conversations/${activeChatId}/commands`, { data: { expectedRevision: revision, action: commit } })).ok()).toBe(true);
		const answers: { path: string; outcome: number | string }[] = [];
		const record = (request: Request, outcome: number | string) => {
			const url = new URL(request.url());
			if (request.frame().url().includes("/api/box-frame/") && url.pathname.includes("/images/")) answers.push({ path: url.pathname.replace(/\/api\/box-frame\/[^/]+/, "frame") + url.search, outcome });
		};
		page.on("response", (response) => record(response.request(), response.status()));
		page.on("requestfailed", (request) => record(request, request.failure()?.errorText ?? "failed"));

		await page.getByRole("button", { name: "Escape Probe", exact: true }).click();
		const frame = page.getByRole("dialog", { name: "Escape Probe" }).frameLocator("iframe");
		await frame.getByLabel("Upload image").setInputFiles(ownImage);
		const owned = await frame.getByRole("status", { name: "Upload" }).filter({ hasText: /^[0-9a-f]{64}$/ }).textContent();
		const surfaces = ["img", "srcset", "background", "poster"];
		const answered = (hash: string | null) => surfaces.map((surface) => answers.filter(({ path }) => path === `frame/images/${hash}?${surface}`).map(({ outcome }) => outcome));
		await expect.poll(() => answered(owned).map((outcomes) => outcomes[0])).toEqual([200, 200, 200, 200]);
		await expect.poll(() => answered(forged).map((outcomes) => outcomes.length > 0)).toEqual([true, true, true, true]);
		expect(answered(forged).flat()).not.toContain(200);
		const loaded = (alt: string) => frame.getByAltText(alt).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0);
		expect([await loaded("image:owned img"), await loaded("image:owned srcset")]).toEqual([true, true]);
		expect([await loaded("image:forged img"), await loaded("image:forged srcset"), await loaded("image:forged app route")]).toEqual([false, false, false]);
		/** @approved The probe's stylesheet also asks the app's image route; the frame's policy refuses those before any request goes out. */
		expect(answers.filter(({ path, outcome }) => path.startsWith("/api/images/") && outcome !== "csp")).toEqual([]);
	});
});
