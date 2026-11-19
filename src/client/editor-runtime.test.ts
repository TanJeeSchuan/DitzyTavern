import { conversationSummary, installFetch } from "./test-fixtures/conversation";
import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { renderHook, flushHook } from "./test-fixtures/render-hook";
import type { ConversationPromptPreset } from "../shared/contract/prompt-preset";
import type { Lorebook } from "./lorebook-library";
import { blankEntry } from "./workspace/lorebook-editor-state";
const { useLorebookEditor } = await import("./workspace/useLorebookEditor");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const book = (id = 1, revision = 1, name = "Book"): Lorebook => ({ id, revision, name, description: "", entries: [{ ...blankEntry(), title: "Entry", id: 7, position: 0 }] });
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
type Request = { url: string; init?: RequestInit };
function install(handler: (request: Request) => Promise<Response>) {
	const requests: Request[] = [];
	installFetch((input: RequestInfo | URL, init?: RequestInit) => {
		const request = { url: String(input), init }; requests.push(request); return handler(request);
	 });
	return requests;
}

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

test("a Lorebook draft saves against the book it started from, so another editor's save conflicts instead of being overwritten", async () => {
	let server = book();
	const sent: number[] = [];
	install(async ({ init }) => {
		if (init?.method !== "POST") return Response.json(server);
		const { expectedRevision, name } = JSON.parse(String(init.body));
		sent.push(expectedRevision);
		if (expectedRevision !== server.revision) {
			return Response.json({ outcome: "conflict", reason: "stale-revision", expectedRevision, actualRevision: server.revision, current: server }, { status: 409 });
		}
		server = book(1, server.revision + 1, name);
		return Response.json({ outcome: "applied", book: server });
	});
	const cache = client();
	const first = await renderHook(() => useLorebookEditor(1), cache); await flushHook();
	const second = await renderHook(() => useLorebookEditor(1), cache); await flushHook();
	await second.act(async () => second.current.setName("Mine"));
	await first.act(async () => first.current.setName("Theirs"));
	await first.act(async () => { expect(await first.current.saveDirty()).toBe(true); }); await flushHook();

	await second.act(async () => { expect(await second.current.saveDirty()).toBe(false); }); await flushHook();
	expect(sent).toEqual([1, 1]);
	expect(server.name).toBe("Theirs");
	expect(second.current.name).toBe("Mine");
	expect(second.current.conflict).toBe(true);

	await second.act(async () => { expect(await second.current.saveDirty()).toBe(false); });
	expect(sent).toEqual([1, 1]);
	await second.act(async () => second.current.keepMine());
	await second.act(async () => { expect(await second.current.saveDirty()).toBe(true); }); await flushHook();
	expect(sent).toEqual([1, 1, 2]);
	expect(server.name).toBe("Mine");
	expect(second.current.dirty).toBe(false);
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
		late.resolve(Response.json({ outcome: "conflict", reason: "stale-revision", expectedRevision: 1, actualRevision: 2, current: book(1, 2, "Older") }, { status: 409 }));
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

const { LorebookEditorDialog } = await import("./workspace/LorebookEditorDialog");
test("Lorebook save-and-leave preserves a replacement leave intent and does not navigate", async () => {
	const late = Promise.withResolvers<Response>();
	install(({ init }) => init?.method === "POST" ? late.promise : Promise.resolve(Response.json(book())));
	const leaves: (number | null)[] = [];
	const hook = await renderHook(() => LorebookEditorDialog({
		bookId: 1, onOpenBook: (id) => { leaves.push(id); }, selectName: false, mutationsDisabled: false,
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

const { usePromptPresetEditor } = await import("./workspace/prompt-preset/usePromptPresetEditor");
const preset = {
	id: 1,
	name: "Story preset",
	slots: [{ id: 7, reference: "instruction", name: "Voice", content: "Original", role: "system", enabled: true }],
} satisfies ConversationPromptPreset;

test("a Prompt Preset save blocks another operation until its refresh settles", async () => {
	const refresh = Promise.withResolvers<Response>();
	const requests = install(({ init }) => init?.method === "POST"
		? Promise.resolve(Response.json({ outcome: "applied" })) : refresh.promise);
	const hook = await renderHook(() => usePromptPresetEditor({
		conversation: conversationSummary(), preset, presetId: undefined, recipePending: false, onConversationChange() {},
	}), client());
	await hook.act(async () => {
		hook.current.setDraft(7, { kind: "content", content: "Submitted", role: "system" });
	});
	let save = Promise.resolve(false);
	await hook.act(async () => {
		save = hook.current.save();
		await hook.current.applySelection(2);
	});
	await flushHook();
	expect(requests.map(({ url }) => new URL(url).pathname)).toEqual([
		"/api/prompt-presets/1/blocks/patches",
		"/api/conversations/1/prompt-preset",
	]);
	await hook.act(async () => {
		refresh.resolve(Response.json({ ...preset, slots: [{ ...preset.slots[0], content: "Submitted" }] }));
		expect(await save).toBe(true);
	});
});

test("a response from a Prompt Preset editor that was left cannot publish a Conversation", async () => {
	const pending = Promise.withResolvers<Response>();
	const requests = install(() => pending.promise);
	const adopted: number[] = [];
	const hook = await renderHook(() => usePromptPresetEditor({
		conversation: conversationSummary(), preset, presetId: undefined, recipePending: false,
		onConversationChange: (conversation) => { adopted.push(conversation.revision); },
	}), client());

	let selection: Promise<unknown> = Promise.resolve();
	await hook.act(async () => { selection = hook.current.applySelection(2); });
	expect(requests).toHaveLength(1);
	await hook.unmount();
	pending.resolve(Response.json({ outcome: "applied", conversation: conversationSummary({ revision: 8 }) }));
	await selection;
	expect(adopted).toEqual([]);
});
