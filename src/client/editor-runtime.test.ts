import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, flushHook } from "./test-fixtures/render-hook";
import type { ConversationSummary } from "./conversation";
import type { ConversationPromptPreset } from "../shared/contract/prompt-preset";
import type { Lorebook } from "./lorebook-library";
import { blankEntry } from "./workspace/lorebook-editor-state";
const { usePromptPresetEditorRuntime } = await import("./workspace/prompt-preset/usePromptPresetEditorRuntime");
const { useLorebookEditor } = await import("./workspace/useLorebookEditor");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const conversation = (id = 1) => {
	// @approved
	// SAFETY: the runtime reads only identity and revision from the Conversation.
	return { id, revision: 1 } as ConversationSummary;
};
const recipe = (id = 1): ConversationPromptPreset => ({ id, name: `Preset ${id}`, slots: [{ id: 7, reference: "instruction", name: "Voice", content: "Original", role: "system", enabled: true }] });
const book = (id = 1, revision = 1, name = "Book"): Lorebook => ({ id, revision, name, description: "", entries: [{ ...blankEntry(), title: "Entry", id: 7, position: 0 }] });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
type Request = { url: string; init?: RequestInit };
function install(handler: (request: Request) => Promise<Response>) {
	const requests: Request[] = [];
	globalThis.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
		const request = { url: String(input), init }; requests.push(request); return handler(request);
	 }, { preconnect() {} });
	return requests;
}

test("Prompt Preset StrictMode and rerenders fetch once; reducer edits compose and operation settlement permits the next selection", async () => {
	const requests = install(async ({ url }) => Response.json(url.endsWith("/prompt-presets") ? { presets: [] } : recipe()));
	const hook = await renderHook(() => usePromptPresetEditorRuntime({ conversation: conversation() }), client(), true);
	await flushHook();
	for (let i = 0; i < 5; i++) await hook.rerender();
	expect(requests).toHaveLength(2);
	expect(hook.current.ready?.selected.id).toBe(1);
	await hook.act(async () => {
		hook.current.dispatch({ type: "draft-changed", blockId: 7, draft: { kind: "content", name: "Voice", content: "Edited", role: "system" } });
		hook.current.dispatch({ type: "enabled-changed", blockId: 7, enabled: false });
	});
	expect(hook.current.state.drafts[7]).toMatchObject({ content: "Edited", enabled: false });
	const effects = { supersedesReads: true, ownsConversation: true, clearNotice: false, clearProblem: false };
	const pending = Promise.withResolvers<void>();
	let first: Promise<unknown> = Promise.resolve();
	let second = 0;
	await hook.act(async () => {
		first = hook.current.runOperation(effects, async () => pending.promise);
		await hook.current.runOperation(effects, async () => { second++; });
	});
	expect(second).toBe(0);
	await hook.act(async () => { pending.resolve(); await first; await hook.current.runOperation(effects, async () => { second++; }); });
	expect(second).toBe(1);
	expect(hook.current.state.busy).toBe(false);
});

test("Prompt Preset key switch aborts the previous recipe and rejects its late completion", async () => {
	const late = Promise.withResolvers<Response>();
	const requests = install(({ url }) => url.endsWith("/prompt-presets") ? Promise.resolve(Response.json({ presets: [] }))
		: url.includes("/1/") ? late.promise : Promise.resolve(Response.json(recipe(2))));
	let selected = conversation();
	const hook = await renderHook(() => usePromptPresetEditorRuntime({ conversation: selected }), client());
	await flushHook();
	const signal = requests.find(({ url }) => url.includes("/1/"))?.init?.signal;
	selected = conversation(2); await hook.rerender(); await flushHook();
	expect(signal?.aborted).toBe(true);
	await hook.act(async () => late.resolve(Response.json(recipe()))); await flushHook();
	expect(hook.current.ready?.selected.id).toBe(2);
});

test("Prompt Preset unmount invalidates an operation claim and every late reducer dispatch", async () => {
	install(async ({ url }) => Response.json(url.endsWith("/prompt-presets") ? { presets: [] } : recipe()));
	const hook = await renderHook(() => usePromptPresetEditorRuntime({ conversation: conversation() }), client()); await flushHook();
	const late = Promise.withResolvers<void>();
	let owned = true;
	let operation: Promise<unknown> = Promise.resolve();
	await hook.act(async () => { operation = hook.current.runOperation({ supersedesReads: true, ownsConversation: false, clearNotice: false, clearProblem: false }, async (claim) => {
			await late.promise;
			owned = hook.current.ownsOperation(claim);
			hook.current.dispatch({ type: "notice-changed", notice: "Late" });
		}); });
	await hook.unmount();
	await hook.act(async () => { late.resolve(); await operation; });
	expect(owned).toBe(false);
	expect(hook.current.state.notice).toBeNull();
});

test("Lorebook StrictMode shares a read, reducer edits compose, and entry selection during save prevents the second write", async () => {
	const late = Promise.withResolvers<Response>();
	const requests = install(({ init }) => init?.method === "POST" ? late.promise : Promise.resolve(Response.json(book())));
	const hook = await renderHook(() => useLorebookEditor(1), client(), true); await flushHook();
	for (let i = 0; i < 5; i++) await hook.rerender();
	expect(requests).toHaveLength(1);
	await hook.act(async () => { hook.current.setName("New book"); hook.current.updateEntryDraft({ ...hook.current.entryDraft, content: "New entry" }); });
	expect(hook.current.name).toBe("New book");
	expect(hook.current.entryDraft.content).toBe("New entry");
	let saving: Promise<boolean> = Promise.resolve(false);
	await hook.act(async () => { saving = hook.current.saveDirty(); }); await flushHook();
	await hook.act(async () => hook.current.selectEntry(null));
	await hook.act(async () => late.resolve(Response.json({ outcome: "applied", book: book(1, 2, "New book") }))); await flushHook();
	expect(await saving).toBe(false);
	expect(requests.filter(({ init }) => init?.method === "POST")).toHaveLength(1);
	expect(JSON.parse(String(requests[1]?.init?.body))).toMatchObject({ type: "update-book", expectedRevision: 1 });
	expect(hook.current.entryId).toBeNull();
});

test("Lorebook key switch aborts its old read and displays only the selected book", async () => {
	const late = Promise.withResolvers<Response>();
	const requests = install(({ url }) => url.endsWith("/1") ? late.promise : Promise.resolve(Response.json(book(2))));
	let id = 1;
	const hook = await renderHook(() => useLorebookEditor(id), client()); await flushHook();
	const signal = requests[0]?.init?.signal;
	id = 2; await hook.rerender(); await flushHook();
	expect(signal?.aborted).toBe(true);
	await hook.act(async () => late.resolve(Response.json(book()))); await flushHook();
	expect(hook.current.book?.id).toBe(2);
});

for (const transition of ["unmount", "A to B to A"] as const) test(`Lorebook save after ${transition} cannot settle or publish into a new editor`, async () => {
	const late = Promise.withResolvers<Response>();
	install(({ url, init }) => init?.method === "POST" ? late.promise : Promise.resolve(Response.json(book(url.endsWith("/2") ? 2 : 1))));
	let id = 1;
	const cache = client();
	const hook = await renderHook(() => useLorebookEditor(id), cache); await flushHook();
	await hook.act(async () => hook.current.setName("Submitted"));
	let saving: Promise<boolean> = Promise.resolve(false);
	await hook.act(async () => { saving = hook.current.saveDirty(); }); await flushHook();
	if (transition === "unmount") await hook.unmount();
	else { id = 2; await hook.rerender(); await flushHook(); id = 1; await hook.rerender(); await flushHook(); await hook.act(async () => hook.current.setName("New draft")); }
	await hook.act(async () => late.resolve(Response.json({ outcome: "applied", book: book(1, 2, "Submitted") }))); await flushHook();
	expect(await saving).toBe(false);
	expect(cache.getQueryData<Lorebook>(["lorebook", 1])?.revision).toBe(1);
	if (transition !== "unmount") { expect(hook.current.name).toBe("New draft"); expect(hook.current.notice).toBeNull(); }
});

test("Lorebook writes reach every reader while retaining another editor's local draft", async () => {
	install(async ({ init }) => Response.json(init?.method === "POST" ? { outcome: "applied", book: book(1, 2, "Saved") } : book()));
	const cache = client();
	const first = await renderHook(() => useLorebookEditor(1), cache); await flushHook();
	const second = await renderHook(() => useLorebookEditor(1), cache); await flushHook();
	await second.act(async () => second.current.setName("Other draft"));
	await first.act(async () => first.current.executeLorebookCommand({ type: "update-book", bookId: 1, expectedRevision: 1, name: "Saved", description: "" })); await flushHook();
	expect(first.current.book?.name).toBe("Saved");
	expect(second.current.book?.name).toBe("Saved");
	expect(second.current.name).toBe("Other draft");
});

test("Prompt Preset refresh reaches another reader and retains its edited block", async () => {
	let fresh = false;
	install(async ({ url }) => Response.json(url.endsWith("/prompt-presets") ? { presets: [] } : { ...recipe(), name: fresh ? "Renamed" : "Preset 1" }));
	const cache = client();
	const first = await renderHook(() => usePromptPresetEditorRuntime({ conversation: conversation() }), cache); await flushHook();
	const second = await renderHook(() => usePromptPresetEditorRuntime({ conversation: conversation() }), cache); await flushHook();
	await second.act(async () => second.current.dispatch({ type: "draft-changed", blockId: 7, draft: { kind: "content", name: "Voice", content: "Local", role: "system" } }));
	fresh = true;
	await first.act(async () => { expect(await first.current.loadRecipe()).toBe("ready"); }); await flushHook();
	expect(first.current.ready?.selected.name).toBe("Renamed");
	expect(second.current.ready?.selected.name).toBe("Renamed");
	expect(second.current.state.drafts[7]).toMatchObject({ content: "Local" });
});

test("Prompt Preset operation cancels a read it supersedes; the late recipe cannot replace the saved view", async () => {
	const late = Promise.withResolvers<Response>();
	let reads = 0;
	const requests = install(({ url }) => url.endsWith("/prompt-presets") ? Promise.resolve(Response.json({ presets: [] }))
		: ++reads === 1 ? Promise.resolve(Response.json(recipe())) : late.promise);
	const hook = await renderHook(() => usePromptPresetEditorRuntime({ conversation: conversation() }), client()); await flushHook();
	let refresh: Promise<unknown> = Promise.resolve();
	await hook.act(async () => { refresh = hook.current.loadRecipe(); }); await flushHook();
	const signal = requests.at(-1)?.init?.signal;
	await hook.act(async () => {
		await hook.current.runOperation({ supersedesReads: true, ownsConversation: false, clearNotice: false, clearProblem: false }, async () => {});
	});
	expect(signal?.aborted).toBe(true);
	await hook.act(async () => { late.resolve(Response.json({ ...recipe(), name: "Late" })); await refresh; }); await flushHook();
	expect(hook.current.ready?.selected.name).toBe("Preset 1");
});

test("Lorebook switching to a loading book clears the previous editor before another write can start", async () => {
	const late = Promise.withResolvers<Response>();
	const requests = install(({ url }) => url.endsWith("/1") ? Promise.resolve(Response.json(book())) : late.promise);
	let id = 1;
	const hook = await renderHook(() => useLorebookEditor(id), client()); await flushHook();
	await hook.act(async () => hook.current.setName("Old draft"));
	id = 2; await hook.rerender(); await flushHook();
	expect(hook.current.book).toBeNull();
	await hook.act(async () => { expect(await hook.current.saveDirty()).toBe(false); });
	expect(requests.filter(({ init }) => init?.method === "POST")).toHaveLength(0);
	await hook.act(async () => late.resolve(Response.json(book(2)))); await flushHook();
	expect(hook.current.book?.id).toBe(2);
});

test("late save conflict cannot roll editor back behind cache", async () => {
	const late = Promise.withResolvers<Response>();
	install(({ init }) => init?.method === "POST" ? late.promise : Promise.resolve(Response.json(book())));
	const cache = client();
	const first = await renderHook(() => useLorebookEditor(1), cache);
	await flushHook();
	const second = await renderHook(() => useLorebookEditor(1), cache);
	await flushHook();
	await first.act(async () => first.current.setName("Local"));
	let saving = Promise.resolve(false);
	await first.act(async () => { saving = first.current.saveDirty(); });
	await flushHook();
	await second.act(async () => cache.setQueryData(["lorebook", 1], book(1, 3, "Newer")));
	await flushHook();
	expect(first.current.book?.revision).toBe(3);
	await first.act(async () => {
		late.resolve(Response.json({ outcome: "conflict", reason: "stale-revision", expectedRevision: 1, actualRevision: 2, currentBook: book(1, 2, "Older") }, { status: 409 }));
		await saving;
	});
	await flushHook();
	expect(first.current.book?.revision).toBe(3);
	expect(second.current.book?.revision).toBe(3);
});

test("pending save sees entry selection queued before result", async () => {
	const late = Promise.withResolvers<Response>();
	const requests = install(({ init }) => init?.method === "POST" ? late.promise : Promise.resolve(Response.json(book())));
	const hook = await renderHook(() => useLorebookEditor(1), client());
	await flushHook();
	await hook.act(async () => { hook.current.setName("New book"); hook.current.updateEntryDraft({ ...hook.current.entryDraft, content: "Submitted" }); });
	let saving = Promise.resolve(false);
	await hook.act(async () => { saving = hook.current.saveDirty(); });
	await flushHook();
	await hook.act(async () => { hook.current.selectEntry(null); late.resolve(Response.json({ outcome: "applied", book: book(1, 2, "New book") })); expect(await saving).toBe(false); });
	expect(requests.filter(x => x.init?.method === "POST")).toHaveLength(1);
});

const { usePromptPresetEditor } = await import("./workspace/prompt-preset/usePromptPresetEditor");
test("Prompt Preset ABA edits cannot close the editor", async () => {
	const late = Promise.withResolvers<Response>();
	let saved = false;
	install(({ url, init }) => init?.method === "POST" ? late.promise : Promise.resolve(Response.json(
		url.endsWith("/prompt-presets") ? { presets: [] } : { ...recipe(), slots: recipe().slots.map(slot => ({ ...slot, content: saved ? "Submitted" : "Original" })) },
	)));
	let closes = 0;
	const hook = await renderHook(() => usePromptPresetEditor({ conversation: conversation(), onConversationChange: () => { }, onClose: () => { closes++; } }), client());
	await flushHook();
	const draft = (content: string) => ({ kind: "content" as const, name: "Voice", content, role: "system" as const });
	await hook.act(async () => hook.current.setDraft(7, draft("Submitted")));
	await hook.act(async () => hook.current.requestClose());
	let saving = Promise.resolve();
	await hook.act(async () => { saving = hook.current.saveAndLeave(); });
	await flushHook();
	await hook.act(async () => { hook.current.setDraft(7, draft("Other")); hook.current.setDraft(7, draft("Submitted")); });
	await hook.act(async () => { saved = true; late.resolve(Response.json({ outcome: "applied" })); await saving; });
	await flushHook();
	expect(closes).toBe(0);
});

const { LorebookEditorDialog } = await import("./workspace/LorebookEditorDialog");
test("Lorebook save-and-leave preserves a replacement leave intent and does not navigate", async () => {
	const late = Promise.withResolvers<Response>();
	install(({ init }) => init?.method === "POST" ? late.promise : Promise.resolve(Response.json(book())));
	const leaves: (number | null)[] = [];
	const hook = await renderHook(() => LorebookEditorDialog({
		bookId: 1, conversationId: 1, onOpenBook: (id) => { leaves.push(id); }, selectName: false, mutationsDisabled: false,
		attachments: { attachmentState: null, attachmentPending: false, updateAttachment: async () => false },
		tester: { testWriting: "", setTestWriting: () => { }, testResult: null, testError: null, testPending: false, runMatchTest: () => { } },
	}), client());
	await flushHook();
	const dialog = () => hook.current.props.children[1];
	const confirmation = () => hook.current.props.children[2];
	await hook.act(async () => dialog().props.children.props.children[0].props.children[2].props.onChange({ target: { value: "Local" } }));
	await hook.act(async () => dialog().props.onOpenChange(false));
	await hook.act(async () => confirmation().props.onSave());
	await flushHook();
	await hook.act(async () => { confirmation().props.onKeepEditing(); dialog().props.onOpenChange(false); });
	await hook.act(async () => late.resolve(Response.json({ outcome: "applied", book: book(1, 2, "Local") })));
	await flushHook();
	expect(leaves).toEqual([]);
	expect(confirmation().props.open).toBe(true);
});
