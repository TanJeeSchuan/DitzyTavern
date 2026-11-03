/* eslint-disable anti-slop/no-runtime-typeof -- The probe reports which escape APIs the Worker has at all. */
// @approved
// Tries every way out of the sandbox from the Worker, then renders markup that tries every way out of the frame.
// Every URL names `sandbox-escape`, so the test server records any request that gets through.
const tried = [];
const attempt = async (name, run) => {
	try { tried.push([name, String(await run())]); } catch (error) { tried.push([name, `blocked: ${error?.name ?? error}`]); }
};
const settles = (target) => new Promise((resolve, reject) => {
	target.onopen = () => resolve("opened");
	target.onerror = () => reject(new Error("error event"));
	setTimeout(() => resolve("pending"), 1000);
});
const escapes = async (base) => {
	await attempt("fetch", () => fetch(`${base}-fetch`).then((response) => response.status));
	await attempt("WebSocket", () => settles(new WebSocket(`${base.replace(/^http/, "ws")}-websocket`)));
	await attempt("EventSource", () => settles(new EventSource(`${base}-eventsource`)));
	await attempt("importScripts", () => importScripts(`${base}-importscripts`));
	await attempt("Worker", () => settles(new Worker(`${base}-worker`)));
	await attempt("blob Worker", () => settles(new Worker(URL.createObjectURL(new Blob([`fetch("${base}-blob-worker").catch(() => {})`], { type: "text/javascript" })))));
	await attempt("FontFace", () => new FontFace("probe", `url(${base}-fontface)`).load());
	await attempt("sendBeacon", () => typeof navigator.sendBeacon === "undefined" ? "undefined" : navigator.sendBeacon(`${base}-beacon`));
};
const markup = (base) => `
	<a href="${base}-a">link</a>
	<a href="javascript:location='${base}-javascript'">javascript link</a>
	<img src="${base}-img" alt="img">
	<img srcset="${base}-srcset 1x" alt="srcset">
	<img src="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><image href='${base}-data-svg'/></svg>" alt="data">
	<div style="background: url(${base}-background); width: 1rem; height: 1rem">background</div>
	<video poster="${base}-poster" width="16" height="16"></video>
	<audio src="${base}-audio" controls></audio>
	<input type="image" src="${base}-input-image" alt="input image">
	<form action="${base}-form"><button>form submit</button></form>
	<button formaction="${base}-formaction">formaction</button>
	<button onclick="location='${base}-onclick'">inline handler</button>
	<img src="missing" onerror="location='${base}-onerror'" alt="onerror">
	<meta http-equiv="refresh" content="0;url=${base}-meta">
	<style>.probe-style-${base.length} { background: url(${base}-style) }</style><div class="probe-style-${base.length}">style</div>
	<svg width="16" height="16"><a xlink:href="${base}-svg"><text y="12">svg</text></a><image href="${base}-svg-image" width="16" height="16"/></svg>
	<iframe src="${base}-iframe"></iframe>
	<object data="${base}-object"></object>
	<embed src="${base}-embed">
	<link rel="stylesheet" href="${base}-link">
	<base href="${base}-base/">`;

// @approved
// Every image surface, for each Image the probe's Library names: the one it uploaded, which it owns, and any hash written there for it.
// Each surface asks for its own URL, so the browser fetches every one of them.
const images = (rows) => rows.map(({ key, value }) => `
	<img src="${host.image(value)}?img" alt="${key} img">
	<img srcset="${host.image(value)}?srcset 1x" alt="${key} srcset">
	<div style="background: url(${host.image(value)}?background); width: 1rem; height: 1rem">${key} background</div>
	<video poster="${host.image(value)}?poster" width="16" height="16"></video>
	<img src="/api/images/${value}" alt="${key} app route">`).join("");

let started = false;
let pings = 0;
let setup = { app: "", other: "", round: 0 };
let stored = [];
let snapshot = 0;
let uploaded = "none";
const draw = () => host.render(`<div class="probe-sheet">
	<output aria-label="Round">${setup.round}</output>
	<output aria-label="Pings">${pings}</output>
	<button type="button" data-on="ping">Ping</button>
	<input type="file" aria-label="Upload image" data-on="upload">
	<output aria-label="Upload">${uploaded}</output>
	${images(stored)}
	<output aria-label="Escapes">${started ? JSON.stringify(tried) : "waiting"}</output>
	${setup.app === "" ? "" : [`${setup.other}/sandbox-escape`, `${setup.app}/api/images/sandbox-escape`].map(markup).join("")}
</div>`);
const upload = async (file) => {
	const result = await host.uploadImage(file);
	if (result.outcome !== "uploaded") return result.reason;
	const owner = { type: "library" };
	const committed = await host.commit({ snapshot, writes: [{ owner, key: "image:owned", value: result.hash }], expected: [{ owner, key: "image:owned", revision: 0 }] });
	return committed.outcome === "applied" ? result.hash : committed.reason;
};
host.onEvent(({ type, name, files }) => {
	if (type === "click" && name === "ping") pings += 1;
	if (type === "change" && name === "upload" && files?.[0] !== undefined) void upload(files[0]).then((outcome) => { uploaded = outcome; draw(); });
	draw();
});
host.onRead(async (read, view) => {
	({ setup, images: stored } = read);
	snapshot = view.snapshot;
	if (setup.app !== "" && !started) {
		started = true;
		for (const base of [`${setup.other}/sandbox-escape`, `${setup.app}/api/images/sandbox-escape`]) await escapes(base);
		// @approved
		// The test server speaks no HTTP/3, so a WebTransport attempt fails whether or not anything blocks it; the row reports whether the Worker has it at all.
		tried.push(["WebTransport", typeof WebTransport], ["RTCPeerConnection", typeof RTCPeerConnection], ["webkitRTCPeerConnection", typeof webkitRTCPeerConnection]);
	}
	draw();
});
