import { afterEach } from "bun:test";
import { act, createElement, StrictMode } from "react";
import type { QueryClient } from "@tanstack/react-query";

const documentStub = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null };
const windowStub = {
	document: documentStub, location: { origin: "http://localhost" }, HTMLIFrameElement: class {},
	addEventListener() {}, removeEventListener() {},
};
Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider } = await import("@tanstack/react-query");
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

export const flushHook = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

export async function renderHook<Value>(hook: () => Value, client: QueryClient, strict = false) {
	Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
	const container: Partial<HTMLElement> = { nodeType: 1, addEventListener() {}, removeEventListener() {}, textContent: "" };
	Object.defineProperties(container, {
		ownerDocument: { value: { ...documentStub, defaultView: windowStub } },
		tagName: { value: "DIV" },
	});
	// @approved
	// SAFETY: the null-rendering probe needs only this event target, owner document, and tag.
	const root = createRoot(container as HTMLElement);
	let value: Value;
	let mounted = true;
	const Probe = () => { value = hook(); return null; };
	const rerender = () => act(async () => {
		const probe = createElement(QueryClientProvider, { client }, createElement(Probe));
		root.render(strict ? createElement(StrictMode, null, probe) : probe);
	});
	const unmount = async () => {
		if (!mounted) return;
		mounted = false;
		await act(async () => root.unmount());
	};
	cleanups.push(async () => { await unmount(); client.clear(); });
	await rerender();
	return { get current() { return value; }, rerender, unmount, act };
}
