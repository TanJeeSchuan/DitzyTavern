import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "./test-fixtures/render-hook";
import type { ReferenceSet } from "../shared/contract/painting";

const { useAdoptReferences, useReferenceDraft } = await import("./painting");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** Answers every painting command, refusing the next `refusals` saves, and records the commands in order. */
const serve = (refusals: number) => {
	const sent: string[] = [];
	globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const command = JSON.parse(String(init?.body));
		sent.push(command.type === "save-reference-set" ? `save:${command.references}` : `${command.type}:${command.references}`);
		if (command.type === "save-reference-set" && refusals-- > 0) return Response.json({ outcome: "invalid", reason: "Disk full." }, { status: 422 });
		return Response.json({ outcome: "accepted" });
	}, { preconnect: () => {} });
	return sent;
};

const render = async (conversationId: number, initial: ReferenceSet) => {
	let selected = initial;
	const hook = await renderHook(() => ({ draft: useReferenceDraft(conversationId, selected), adoption: useAdoptReferences(conversationId) }), new QueryClient());
	return { hook, select: (next: ReferenceSet) => { selected = next; return hook.rerender(); } };
};

test("a failed save keeps the edit, and adopting an Illustration's References waits for the save and runs only once it lands", async () => {
	const { hook } = await render(1, { id: "default", name: "References", references: "Iris: silks" });
	const sent = serve(1);
	await hook.act(async () => { hook.current.draft.edit("Iris: kimono"); });
	let adopted = true;
	await hook.act(async () => { adopted = await hook.current.adoption.adopt("Bridge", "Iris: silks"); });
	expect(adopted).toBe(false);
	expect(hook.current.adoption.error).toBe("Disk full.");
	expect(hook.current.draft.references).toBe("Iris: kimono");
	await hook.act(async () => { adopted = await hook.current.adoption.adopt("Bridge", "Iris: silks"); });
	expect(adopted).toBe(true);
	expect(sent).toEqual(["save:Iris: kimono", "save:Iris: kimono", "adopt-reference-set:Iris: silks"]);
});

test("once an edit is saved, the set shows text saved later from elsewhere", async () => {
	const { hook, select } = await render(2, { id: "default", name: "References", references: "Iris: silks" });
	serve(0);
	await hook.act(async () => { hook.current.draft.edit("Iris: kimono"); });
	await hook.act(async () => { await hook.current.draft.flush(); });
	await select({ id: "default", name: "References", references: "Changed in second tab" });
	expect(hook.current.draft.references).toBe("Changed in second tab");
});

test("an edit made while a save is in flight is saved before adopting an Illustration's References", async () => {
	const { hook } = await render(3, { id: "default", name: "References", references: "Iris: silks" });
	const sent: string[] = [];
	const held = Promise.withResolvers<void>();
	globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const command = JSON.parse(String(init?.body));
		sent.push(`${command.type}:${command.references}`);
		if (sent.length === 1) await held.promise;
		return Response.json({ outcome: "accepted" });
	}, { preconnect: () => {} });
	await hook.act(async () => { hook.current.draft.edit("Iris: kimono"); });
	let adoption: Promise<boolean> = Promise.resolve(false);
	await hook.act(async () => { adoption = hook.current.adoption.adopt("Bridge", "Iris: silks"); });
	await hook.act(async () => { hook.current.draft.edit("Iris: kimono, hair down"); });
	held.resolve();
	await hook.act(async () => { expect(await adoption).toBe(true); });
	expect(sent).toEqual(["save-reference-set:Iris: kimono", "save-reference-set:Iris: kimono, hair down", "adopt-reference-set:Iris: silks"]);
});

test("an edit made while an adoption is in flight is still saved after the adoption switches sets", async () => {
	const { hook, select } = await render(4, { id: "a", name: "A", references: "Iris: silks" });
	const sent: string[] = [];
	const held = Promise.withResolvers<void>();
	globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const command = JSON.parse(String(init?.body));
		sent.push(`${command.type}:${command.id ?? ""}:${command.references}`);
		if (command.type === "adopt-reference-set") await held.promise;
		return Response.json({ outcome: "accepted" });
	}, { preconnect: () => {} });
	let adoption: Promise<boolean> = Promise.resolve(false);
	await hook.act(async () => { adoption = hook.current.adoption.adopt("Bridge", "Iris: kimono"); });
	await hook.act(async () => { hook.current.draft.edit("Iris: silks, hair down"); });
	held.resolve();
	await hook.act(async () => { await adoption; });
	await select({ id: "b", name: "Bridge", references: "Iris: kimono" });
	await hook.act(async () => { hook.current.draft.edit("Iris: kimono, sash"); });
	await hook.act(async () => { await hook.current.draft.flush(); });
	expect(sent).toEqual(["adopt-reference-set::Iris: kimono", "save-reference-set:a:Iris: silks, hair down", "save-reference-set:b:Iris: kimono, sash"]);
});
