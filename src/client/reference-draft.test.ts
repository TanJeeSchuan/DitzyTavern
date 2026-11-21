import { afterEach, expect, test } from "bun:test";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { withDeadline } from "../shared/test-fixtures/deadline";
import { renderHook } from "./test-fixtures/render-hook";
import type { IllustrationsRead } from "../shared/contract/painting";
import type { ReferenceSet } from "../shared/contract/reference-set";

const { useAdoptReferences, useReferenceDraft, illustrationsKey } = await import("./painting");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** Answers every painting command, refusing the next `refusals` saves, and records the commands in order. */
const serve = (refusals: number) => {
	const sent: string[] = [];
	globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const command = JSON.parse(String(init?.body));
		sent.push(command.type === "save-reference-set" ? `save:${command.references}` : `${command.type}:${command.references}`);
		if (command.type === "save-reference-set" && refusals-- > 0) return Response.json({ outcome: "invalid", reason: "Disk full." }, { status: 422 });
		return replyOf(command.type === "save-reference-set" ? command.id : "b", command.references);
	}, { preconnect: () => {} });
	return sent;
};

const readOf = (set: ReferenceSet): IllustrationsRead => ({
	paintPresetId: 1, briefMessageCount: 5, paintPresets: [], aspectRatio: "1:1", paintings: [], referenceSets: [set], referenceSetId: set.id,
});
const replyOf = (id: string, references: string) => Response.json({ outcome: "references-updated", selection: {
	referenceSets: [{ id, name: id === "b" ? "Bridge" : "References", references }], referenceSetId: id,
} });

const render = async (conversationId: number, initial: ReferenceSet) => {
	const client = new QueryClient();
	const queryKey = illustrationsKey(conversationId);
	client.setQueryData(queryKey, readOf(initial));
	let selected = initial;
	const hook = await renderHook(() => {
		useQuery({ queryKey, queryFn: async () => { throw new Error("offline"); }, refetchOnMount: false, retry: false });
		return { draft: useReferenceDraft(conversationId, selected), adoption: useAdoptReferences(conversationId) };
	}, client);
	return { hook, client, select: (next: ReferenceSet) => { selected = next; return hook.rerender(); } };
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
		sent.push(command.type === "save-reference-set" ? `${command.expectedReferences} → ${command.references}` : command.references);
		if (sent.length === 1) await withDeadline(held.promise, "first save release");
		return replyOf(command.id ?? "b", command.references);
	}, { preconnect: () => {} });
	await hook.act(async () => { hook.current.draft.edit("Iris: kimono"); });
	await hook.act(async () => { void hook.current.draft.flush(); });
	await hook.act(async () => { hook.current.draft.edit("Iris: kimono, hair down"); });
	let adoption: Promise<boolean> = Promise.resolve(false);
	await hook.act(async () => { adoption = hook.current.adoption.adopt("Bridge", "Iris: silks"); });
	held.resolve();
	await hook.act(async () => { expect(await withDeadline(adoption, "adoption to finish")).toBe(true); });
	expect(sent).toEqual(["Iris: silks → Iris: kimono", "Iris: kimono → Iris: kimono, hair down", "Iris: silks"]);
});

test("a saved edit stays visible when its Illustrations read-back fails", async () => {
	const client = new QueryClient();
	const queryKey = illustrationsKey(5);
	client.setQueryData(queryKey, readOf({ id: "default", name: "References", references: "Iris: silks" }));
	serve(0);
	const hook = await renderHook(() => {
		const read = useQuery<IllustrationsRead>({ queryKey, queryFn: async () => { throw new Error("offline"); }, refetchOnMount: false, retry: false });
		return useReferenceDraft(5, read.data?.referenceSets[0]);
	}, client);
	await hook.act(async () => { hook.current.edit("Iris: kimono"); });
	await hook.act(async () => { expect(await hook.current.flush()).toBe(true); });
	await hook.act(async () => { await client.invalidateQueries({ queryKey }); });
	expect(client.getQueryState(queryKey)?.error).toEqual(new Error("offline"));
	expect(hook.current.references).toBe("Iris: kimono");
});

test("an adoption publishes the selection returned by the command even when the Illustrations read fails", async () => {
	const { hook, client } = await render(6, { id: "default", name: "References", references: "Unrelated" });
	serve(0);
	await hook.act(async () => { expect(await hook.current.adoption.adopt("Bridge", "Iris: kimono")).toBe(true); });
	await hook.act(async () => { await client.invalidateQueries({ queryKey: illustrationsKey(6) }); });
	expect(client.getQueryData<IllustrationsRead>(illustrationsKey(6))).toMatchObject({
		referenceSetId: "b", referenceSets: [{ id: "b", name: "Bridge", references: "Iris: kimono" }],
	});
});

test("References are locked while an adoption is in flight, so the adopted set is what the editor shows", async () => {
	const { hook } = await render(7, { id: "b", name: "Bridge", references: "Iris: kimono" });
	const held = Promise.withResolvers<void>();
	globalThis.fetch = Object.assign(async () => { await withDeadline(held.promise, "adoption release"); return replyOf("b", "Iris: kimono"); }, { preconnect: () => {} });
	let adoption: Promise<boolean> = Promise.resolve(false);
	await hook.act(async () => { adoption = hook.current.adoption.adopt("Bridge", "Iris: kimono"); });
	expect(hook.current.draft.locked).toBe(true);
	await hook.act(async () => { hook.current.draft.edit("Iris: kimono, typed during the adoption"); });
	held.resolve();
	await hook.act(async () => { expect(await withDeadline(adoption, "adoption to finish")).toBe(true); });
	expect(hook.current.draft.locked).toBe(false);
	expect(hook.current.draft.references).toBe("Iris: kimono");
});

test("a second adoption is refused while one is in flight, so the lock lasts until the first finishes", async () => {
	const { hook } = await render(8, { id: "b", name: "Bridge", references: "Iris: kimono" });
	const held = Promise.withResolvers<void>();
	const sent: string[] = [];
	globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
		sent.push(JSON.parse(String(init?.body)).references);
		await withDeadline(held.promise, "first adoption release");
		return replyOf("b", "Iris: kimono");
	}, { preconnect: () => {} });
	let first: Promise<boolean> = Promise.resolve(false);
	let second = true;
	await hook.act(async () => { first = hook.current.adoption.adopt("Bridge", "Iris: kimono"); });
	await hook.act(async () => { second = await hook.current.adoption.adopt("Lantern", "Iris: lantern"); });
	expect(second).toBe(false);
	await hook.act(async () => { second = await hook.current.adoption.adopt("Painted before References", ""); });
	expect(second).toBe(false);
	expect(hook.current.draft.locked).toBe(true);
	held.resolve();
	await hook.act(async () => { expect(await withDeadline(first, "first adoption to finish")).toBe(true); });
	expect(sent).toEqual(["Iris: kimono"]);
});

test("a set switch in flight refuses an adoption, so the switch cannot land after Use Brief succeeds", async () => {
	const { hook } = await render(9, { id: "a", name: "A", references: "Iris: silks" });
	const sent = serve(0);
	const switching = Promise.withResolvers<boolean>();
	let finished: Promise<boolean> = Promise.resolve(false);
	let adopted = true;
	await hook.act(async () => { finished = hook.current.draft.exclusively(() => withDeadline(switching.promise, "set switch release")); });
	await hook.act(async () => { adopted = await hook.current.adoption.adopt("Bridge", "Iris: kimono"); });
	expect(adopted).toBe(false);
	expect(sent).toEqual([]);
	switching.resolve(true);
	await hook.act(async () => { expect(await withDeadline(finished, "set switch to finish")).toBe(true); });
	expect(hook.current.draft.locked).toBe(false);
});

test("storage failures leave edits in memory and do not poison the save queue", async () => {
	const { hook } = await render(10, { id: "default", name: "References", references: "Iris: silks" });
	const sent = serve(0);
	const storage = new Map<string, string>();
	let quotaFull = true;
	Object.defineProperty(window, "localStorage", { configurable: true, value: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => { if (quotaFull) throw new Error("Quota exceeded"); storage.set(key, value); },
		removeItem: () => { throw new Error("Storage is unavailable"); },
	} });
	try {
		await hook.act(async () => { hook.current.draft.edit("First draft"); });
		expect(hook.current.draft.references).toBe("First draft");
		expect(hook.current.draft.storageUnavailable).toBe(true);
		await hook.act(async () => { expect(await hook.current.draft.flush()).toBe(true); });
		quotaFull = false;
		await hook.act(async () => { hook.current.draft.edit("Second draft"); });
		await hook.act(async () => { expect(await hook.current.draft.flush()).toBe(true); });
		await hook.act(async () => { hook.current.draft.edit("Third draft"); });
		await hook.act(async () => { expect(await hook.current.draft.flush()).toBe(true); });
		expect(sent).toEqual(["save:First draft", "save:Second draft", "save:Third draft"]);
	} finally { Reflect.deleteProperty(window, "localStorage"); }
});
