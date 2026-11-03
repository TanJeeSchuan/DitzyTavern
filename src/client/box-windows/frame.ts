/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof -- The frame relays structured data from guest code, which it checks before it acts on it. */
import DOMPurify from "dompurify";
import { Idiomorph } from "idiomorph";
import type { AppToFrame, FrameToApp } from "./frame-protocol";

// @approved
//  The host script of a Box frame, the only script that runs in its document.
// The guest's `ui.js` runs in a Worker started from a blob, after this
// prelude, which gives it `host`. A Worker has no DOM and inherits the
// frame's policy and opaque origin, so it reaches no network; it renders by
// sending markup, which this script sanitizes into the document, and asks
// the app for commits and uploads, which answer through `reply`.
function workerPrelude(images: string) {
	type View = { moves: unknown; disabled: unknown; stale: unknown; snapshot: unknown };
	let onRead: ((read: unknown, view: View) => void) | undefined;
	let onEvent: ((event: unknown) => void) | undefined;
	let onSave: (() => unknown) | undefined;
	let onDiscard: (() => void) | undefined;
	let next = 0;
	const pending = new Map<number, (result: unknown) => void>();
	const request = (type: "commit" | "upload", key: "commit" | "file", value: unknown) => new Promise((resolve) => {
		const id = next++;
		pending.set(id, resolve);
		postMessage({ type, id, [key]: value });
	});
	self.onmessage = ({ data }: MessageEvent<{ type: string; id?: number; read?: unknown; view?: View; event?: unknown; result?: unknown }>) => {
		if (data.type === "read" && data.view !== undefined) onRead?.(data.read, data.view);
		if (data.type === "event") onEvent?.(data.event);
		if (data.type === "reply" && data.id !== undefined) {
			pending.get(data.id)?.(data.result);
			pending.delete(data.id);
		}
		if (data.type === "save") {
			const id = data.id;
			Promise.resolve().then(() => onSave?.()).then((saved) => postMessage({ type: "saved", id, saved: saved === true }), () => postMessage({ type: "saved", id, saved: false }));
		}
		if (data.type === "discard") onDiscard?.();
	};
	return Object.freeze({
		onRead: (handler: typeof onRead) => { onRead = handler; },
		onEvent: (handler: typeof onEvent) => { onEvent = handler; },
		render: (html: unknown) => postMessage({ type: "render", html: String(html) }),
		stageMoves: (moves: unknown) => postMessage({ type: "stage", moves }),
		commit: (commit: unknown) => request("commit", "commit", commit),
		uploadImage: (file: unknown) => request("upload", "file", file),
		image: (hash: unknown) => images + encodeURIComponent(String(hash)),
		setDirty: (dirty: unknown) => postMessage({ type: "dirty", dirty: dirty === true }),
		onSave: (handler: typeof onSave) => { onSave = handler; },
		onDiscard: (handler: typeof onDiscard) => { onDiscard = handler; },
	});
}

/** @approved This frame's own image path, under its token; its policy admits no other image URL. */
const images = `${location.pathname}/images/`;
const imageAttributes = new Set(["src", "srcset", "poster"]);

// @approved
//  Markup can neither run code nor navigate: no element that loads a document,
// a script or a form, no link or form target, no event handler (DOMPurify
// drops those itself), and no `data:` or `javascript:` URL in any attribute.
// An image attribute keeps only URLs on this frame's image path, as the
// frame's policy also requires of CSS backgrounds.
const purify = DOMPurify(window);
purify.addHook("uponSanitizeAttribute", (_, attribute) => {
	if (/^\s*(?:data|javascript):/i.test(attribute.attrValue)) attribute.keepAttr = false;
	if (imageAttributes.has(attribute.attrName) && !attribute.attrValue.split(",").every((candidate) => candidate.trim().startsWith(images))) attribute.keepAttr = false;
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

// @approved
//  Each render morphs the document into the sanitized markup, so elements the
// markup keeps stay in place: an input keeps its focus, caret and the value
// being typed into it, and a CSS transition runs between two renders.
const start = (ui: string, css: string) => {
	guestStyle.textContent = css;
	const url = URL.createObjectURL(new Blob([`const host = (${String(workerPrelude)})(${JSON.stringify(images)});\n${ui}`], { type: "text/javascript" }));
	worker = new Worker(url);
	URL.revokeObjectURL(url);
	worker.onerror = (event) => send({ type: "error", message: event.message || "Its UI script failed." });
	worker.onmessageerror = () => send({ type: "error", message: "Its UI sent a message the frame could not read." });
	worker.onmessage = ({ data }: MessageEvent<{ type?: unknown; html?: unknown; moves?: unknown; id?: unknown; commit?: unknown; file?: unknown; dirty?: unknown; saved?: unknown }>) => {
		if (data.type === "render" && typeof data.html === "string") Idiomorph.morph(document.body, sanitized(data.html), { morphStyle: "innerHTML", ignoreActiveValue: true });
		if (data.type === "stage") send({ type: "stage", moves: data.moves });
		if (data.type === "commit") send({ type: "commit", id: data.id, commit: data.commit });
		if (data.type === "upload") send({ type: "upload", id: data.id, file: data.file });
		if (data.type === "dirty") send({ type: "dirty", dirty: data.dirty });
		if (data.type === "saved") send({ type: "saved", id: data.id, saved: data.saved });
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
		if (data.type === "start") {
			if (worker === undefined) start(data.ui, data.css);
		} else worker?.postMessage(data);
	};
});
addEventListener("pagehide", () => worker?.terminate());

// @approved
//  Elements carrying `data-on="<name>"` report clicks, input and changes to the
// guest as `{ type, name, data, value }`: the event type, the name, the
// element's data attributes and its value, or a checkbox's checked state. A
// file input reports the files picked as `files` instead, and is cleared so
// the same file can be picked again.
for (const type of ["click", "input", "change"]) {
	document.addEventListener(type, (event) => {
		const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-on]") : null;
		if (element === null) return;
		const file = element instanceof HTMLInputElement && element.type === "file";
		const value = file ? undefined : element instanceof HTMLInputElement && element.type === "checkbox" ? element.checked
			: element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element.value : undefined;
		const files = file && type === "change" ? [...element.files ?? []] : undefined;
		worker?.postMessage({ type: "event", event: { type, name: element.dataset.on, data: { ...element.dataset }, value, ...files && { files } } });
		if (files !== undefined) element.value = "";
	});
}
