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
	await attempt("WebTransport", () => typeof WebTransport === "undefined" ? "undefined" : new WebTransport(`${base.replace(/^http:/, "https:")}-webtransport`).ready);
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

let started = false;
let pings = 0;
let setup = { app: "", other: "", round: 0 };
const draw = () => host.render(`<div class="probe-sheet">
	<output aria-label="Round">${setup.round}</output>
	<output aria-label="Pings">${pings}</output>
	<button type="button" data-on="ping">Ping</button>
	<output aria-label="Escapes">${started ? JSON.stringify(tried) : "waiting"}</output>
	${setup.app === "" ? "" : [`${setup.other}/sandbox-escape`, `${setup.app}/api/images/sandbox-escape`].map(markup).join("")}
</div>`);
host.onEvent(({ type, name }) => {
	if (type === "click" && name === "ping") pings += 1;
	draw();
});
host.onRead(async (read) => {
	setup = read;
	if (setup.app !== "" && !started) {
		started = true;
		for (const base of [`${setup.other}/sandbox-escape`, `${setup.app}/api/images/sandbox-escape`]) await escapes(base);
		tried.push(["RTCPeerConnection", typeof RTCPeerConnection], ["webkitRTCPeerConnection", typeof webkitRTCPeerConnection]);
	}
	draw();
});
