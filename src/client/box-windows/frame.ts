/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- The frame relays structured data from guest code, which it checks before it acts on it. */
import DOMPurify from "dompurify";
import type { AppToFrame, FrameToApp } from "./frame-protocol";

// @approved
//  The host script of a Box frame, the only script that runs in its document.
// The guest's `ui.js` runs in a Worker started from a blob, after this
// prelude, which gives it `host`. A Worker has no DOM and inherits the
// frame's policy and opaque origin, so it reaches no network; it renders by
// sending markup, which this script sanitizes into the document.
function workerPrelude() {
	let onRead: ((read: unknown, view: { moves: unknown; disabled: unknown }) => void) | undefined;
	let onEvent: ((event: unknown) => void) | undefined;
	self.onmessage = ({ data }: MessageEvent<{ type: string; read?: unknown; moves?: unknown; disabled?: unknown; event?: unknown }>) => {
		if (data.type === "read") onRead?.(data.read, { moves: data.moves, disabled: data.disabled });
		if (data.type === "event") onEvent?.(data.event);
	};
	return Object.freeze({
		onRead: (handler: typeof onRead) => { onRead = handler; },
		onEvent: (handler: typeof onEvent) => { onEvent = handler; },
		render: (html: unknown) => postMessage({ type: "render", html: String(html) }),
		stageMoves: (moves: unknown) => postMessage({ type: "stage", moves }),
	});
}

// @approved
//  Markup can neither run code nor navigate: no element that loads a document,
// a script or a form, no link or form target, no event handler (DOMPurify
// drops those itself), and no `data:` or `javascript:` URL in any attribute.
const purify = DOMPurify(window);
purify.addHook("uponSanitizeAttribute", (_, attribute) => {
	if (/^\s*(?:data|javascript):/i.test(attribute.attrValue)) attribute.keepAttr = false;
});
const sanitized = (html: string) => purify.sanitize(html, {
	RETURN_DOM_FRAGMENT: true,
	FORBID_TAGS: ["script", "iframe", "object", "embed", "meta", "link", "base", "form"],
	FORBID_ATTR: ["href", "action", "formaction", "xlink:href"],
});

let port: MessagePort | undefined;
let worker: Worker | undefined;
const guestStyle = document.createElement("style");
document.head.append(guestStyle);
const send = (message: FrameToApp) => port?.postMessage(message);

const start = (ui: string, css: string) => {
	guestStyle.textContent = css;
	const url = URL.createObjectURL(new Blob([`const host = (${String(workerPrelude)})();\n${ui}`], { type: "text/javascript" }));
	worker = new Worker(url);
	URL.revokeObjectURL(url);
	worker.onerror = (event) => send({ type: "error", message: event.message || "Its UI script failed." });
	worker.onmessageerror = () => send({ type: "error", message: "Its UI sent a message the frame could not read." });
	worker.onmessage = ({ data }: MessageEvent<{ type?: unknown; html?: unknown; moves?: unknown }>) => {
		if (data.type === "render" && typeof data.html === "string") document.body.replaceChildren(sanitized(data.html));
		if (data.type === "stage") send({ type: "stage", moves: data.moves });
	};
};

// @approved
//  The app hands the frame its port in the first message that carries one;
// every later window message, port or not, is ignored, so only the app that
// embedded the frame talks to it.
addEventListener("message", (event) => {
	const [handed] = event.ports;
	if (port !== undefined || handed === undefined) return;
	port = handed;
	port.onmessage = ({ data }: MessageEvent<AppToFrame>) => {
		if (data.type === "start" && worker === undefined) start(data.ui, data.css);
		if (data.type === "read") worker?.postMessage(data);
	};
});
addEventListener("pagehide", () => worker?.terminate());

// @approved
//  Elements carrying `data-on="<name>"` report clicks, input and changes to the
// guest as `{ type, name, data, value }`: the event type, the name, the
// element's data attributes and its value, or a checkbox's checked state.
for (const type of ["click", "input", "change"]) {
	document.addEventListener(type, (event) => {
		const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-on]") : null;
		if (element === null) return;
		const value = element instanceof HTMLInputElement && element.type === "checkbox" ? element.checked
			: element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element.value : undefined;
		worker?.postMessage({ type: "event", event: { type, name: element.dataset.on, data: { ...element.dataset }, value } });
	});
}
