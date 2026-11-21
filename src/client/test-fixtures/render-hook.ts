import { act, createElement, StrictMode, type ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";

const documentStub = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null };
const { createRoot } = await import("react-dom/client");
const { QueryClientProvider, notifyManager } = await import("@tanstack/react-query");
const cleanups: (() => Promise<void>)[] = [];
let restoreReactGlobals: (() => void) | undefined;

export const cleanupRenderedHooks = async () => {
	try {
		for (const cleanup of cleanups.splice(0)) await cleanup();
	} finally {
		restoreReactGlobals?.();
		restoreReactGlobals = undefined;
	}
};

export const flushHook = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** @approved Renders a tree of components that render no host elements, such as one whose leaf reports what it was given and returns null. */
export async function renderTree(tree: () => ReactNode, client: QueryClient) {
	const hook = await renderHook(() => undefined, client, false, tree);
	return { rerender: hook.rerender, act: hook.act };
}

export async function renderHook<Value>(hook: () => Value, client: QueryClient, strict = false, tree: () => ReactNode = () => null) {
	if (restoreReactGlobals === undefined) {
		const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
		if (previousWindow === undefined) throw new Error("The window preload is required by renderHook.");
		const actEnvironment = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
		Object.defineProperty(globalThis, "window", { configurable: true, value: { ...window, document: documentStub, HTMLIFrameElement: class {} } });
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		// @approved
		// Query results notify observers on a timer, which can land between act scopes.
		notifyManager.setNotifyFunction((notify) => act(notify));
		restoreReactGlobals = () => {
			Object.defineProperty(globalThis, "window", previousWindow);
			if (actEnvironment === undefined) Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
			else Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
		};
	}
	const container: Partial<HTMLElement> = { nodeType: 1, addEventListener() {}, removeEventListener() {}, textContent: "" };
	Object.defineProperties(container, {
		ownerDocument: { value: { ...documentStub, defaultView: window } },
		tagName: { value: "DIV" },
	});
	// @approved
	// SAFETY: the null-rendering probe needs only this event target, owner document, and tag.
	const root = createRoot(container as HTMLElement);
	let value: Value;
	let mounted = true;
	const Probe = () => { value = hook(); return tree(); };
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
