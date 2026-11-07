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
	const frameDocument = page.frames().find((candidate) => candidate.url().endsWith("/api/box-frame"));
	expect(frameDocument).toBeDefined();

	// The recorder sees a request from outside the sandbox, so its silence about the probe's own means none got through.
	await request.get(`${other}/sandbox-escape-control`);
	await expect.poll(async () => (await llm.log()).probes).toEqual([`${other}/sandbox-escape-control`]);
	expect(page.url()).toBe(appPage);
	expect(frameDocument?.url()).toBe(`${app}/api/box-frame`);

	// A port the frame accepted would deliver this read before the Ping click reaches the guest, so Round would show 99 by the time the next Ping shows.
	await page.evaluate(() => {
		const { port1, port2 } = new MessageChannel();
		document.querySelector<HTMLIFrameElement>("iframe.box-frame")?.contentWindow?.postMessage(null, "*", [port2]);
		port1.postMessage({ type: "read", read: { app: "", other: "", round: 99 }, moves: null, disabled: false });
	});
	const pings = frame.getByRole("status", { name: "Pings" });
	const before = Number(await pings.textContent());
	await frame.getByRole("button", { name: "Ping" }).click();
	await expect(pings).toHaveText(String(before + 1));
	await expect(frame.getByRole("status", { name: "Round" })).toHaveText("1");
});
