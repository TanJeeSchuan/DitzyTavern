import { afterEach, expect, test } from "bun:test";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { renderHook } from "./test-fixtures/render-hook";
import type { IllustrationsRead, ReferenceSet } from "../shared/contract/painting";

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
		return Response.json({ outcome: "accepted" });
	}, { preconnect: () => {} });
	return sent;
};

const readOf = (set: ReferenceSet): IllustrationsRead => ({
	paintPresetId: 1, briefMessageCount: 5, paintPresets: [], aspectRatio: "1:1", paintings: [], referenceSets: [set], referenceSetId: set.id,
});
const bridge = (references: string) => () => readOf({ id: "b", name: "Bridge", references });

/** `readBack` answers the Illustrations read that follows each command. */
const render = async (conversationId: number, initial: ReferenceSet, readBack = () => readOf(initial)) => {
	let selected = initial;
	const hook = await renderHook(() => {
		useQuery({ queryKey: illustrationsKey(conversationId), queryFn: async () => readBack(), retry: false });
		return { draft: useReferenceDraft(conversationId, selected), adoption: useAdoptReferences(conversationId) };
	}, new QueryClient());
	return { hook, select: (next: ReferenceSet) => { selected = next; return hook.rerender(); } };
};

test("a failed save keeps the edit, and adopting an Illustration's References waits for the save and runs only once it lands", async () => {
	const { hook } = await render(1, { id: "default", name: "References", references: "Iris: silks" }, bridge("Iris: silks"));
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
	const { hook } = await render(3, { id: "default", name: "References", references: "Iris: silks" }, bridge("Iris: silks"));
	const sent: string[] = [];
	const held = Promise.withResolvers<void>();
	globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const command = JSON.parse(String(init?.body));
		sent.push(`${command.type}:${command.references}`);
		if (sent.length === 1) await held.promise;
		return Response.json({ outcome: "accepted" });
	}, { preconnect: () => {} });
	await hook.act(async () => { hook.current.draft.edit("Iris: kimono"); });
	await hook.act(async () => { void hook.current.draft.flush(); });
	await hook.act(async () => { hook.current.draft.edit("Iris: kimono, hair down"); });
	let adoption: Promise<boolean> = Promise.resolve(false);
	await hook.act(async () => { adoption = hook.current.adoption.adopt("Bridge", "Iris: silks"); });
	held.resolve();
	await hook.act(async () => { expect(await adoption).toBe(true); });
	expect(sent).toEqual(["save-reference-set:Iris: kimono", "save-reference-set:Iris: kimono, hair down", "adopt-reference-set:Iris: silks"]);
});

test("a save shows the saved References before any read-back lands", async () => {
	const client = new QueryClient();
	client.setQueryData(illustrationsKey(5), {
		paintPresetId: 1, briefMessageCount: 5, paintPresets: [], aspectRatio: "1:1", paintings: [],
		referenceSets: [{ id: "default", name: "References", references: "Iris: silks" }], referenceSetId: "default",
	});
	serve(0);
	const hook = await renderHook(() => {
		const read = useQuery<IllustrationsRead>({ queryKey: illustrationsKey(5), enabled: false });
		return useReferenceDraft(5, read.data?.referenceSets[0]);
	}, client);
	await hook.act(async () => { hook.current.edit("Iris: kimono"); });
	await hook.act(async () => { expect(await hook.current.flush()).toBe(true); });
	expect(hook.current.references).toBe("Iris: kimono");
});

test("an accepted adoption whose read-back fails reports failure, so Use Brief keeps the Brief it had", async () => {
	const { hook } = await render(6, { id: "default", name: "References", references: "Unrelated" }, () => { throw new Error("offline"); });
	serve(0);
	let adopted = true;
	await hook.act(async () => { adopted = await hook.current.adoption.adopt("Bridge", "Iris: kimono"); });
	expect(adopted).toBe(false);
	expect(hook.current.adoption.error).toBe("The References could not be loaded. Try again.");
});

test("References are locked while an adoption is in flight, so the adopted set is what the editor shows", async () => {
	const { hook } = await render(7, { id: "b", name: "Bridge", references: "Iris: kimono" }, bridge("Iris: kimono"));
	const held = Promise.withResolvers<void>();
	globalThis.fetch = Object.assign(async () => { await held.promise; return Response.json({ outcome: "accepted" }); }, { preconnect: () => {} });
	let adoption: Promise<boolean> = Promise.resolve(false);
	await hook.act(async () => { adoption = hook.current.adoption.adopt("Bridge", "Iris: kimono"); });
	expect(hook.current.draft.locked).toBe(true);
	await hook.act(async () => { hook.current.draft.edit("Iris: kimono, typed during the adoption"); });
	held.resolve();
	await hook.act(async () => { expect(await adoption).toBe(true); });
	expect(hook.current.draft.locked).toBe(false);
	expect(hook.current.draft.references).toBe("Iris: kimono");
});

test("a second adoption is refused while one is in flight, so the lock lasts until the first finishes", async () => {
	const { hook } = await render(8, { id: "b", name: "Bridge", references: "Iris: kimono" }, bridge("Iris: kimono"));
	const held = Promise.withResolvers<void>();
	const sent: string[] = [];
	globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
		sent.push(JSON.parse(String(init?.body)).references);
		await held.promise;
		return Response.json({ outcome: "accepted" });
	}, { preconnect: () => {} });
	let first: Promise<boolean> = Promise.resolve(false);
	let second = true;
	await hook.act(async () => { first = hook.current.adoption.adopt("Bridge", "Iris: kimono"); });
	await hook.act(async () => { second = await hook.current.adoption.adopt("Lantern", "Iris: lantern"); });
	expect(second).toBe(false);
	expect(hook.current.draft.locked).toBe(true);
	held.resolve();
	await hook.act(async () => { expect(await first).toBe(true); });
	expect(sent).toEqual(["Iris: kimono"]);
});

test("a set switch in flight refuses an adoption, so the switch cannot land after Use Brief succeeds", async () => {
	const { hook } = await render(9, { id: "a", name: "A", references: "Iris: silks" }, bridge("Iris: kimono"));
	const sent = serve(0);
	const switching = Promise.withResolvers<boolean>();
	let finished: Promise<boolean> = Promise.resolve(false);
	let adopted = true;
	await hook.act(async () => { finished = hook.current.draft.exclusively(() => switching.promise); });
	await hook.act(async () => { adopted = await hook.current.adoption.adopt("Bridge", "Iris: kimono"); });
	expect(adopted).toBe(false);
	expect(sent).toEqual([]);
	switching.resolve(true);
	await hook.act(async () => { expect(await finished).toBe(true); });
	expect(hook.current.draft.locked).toBe(false);
});
