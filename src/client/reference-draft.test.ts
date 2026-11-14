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
