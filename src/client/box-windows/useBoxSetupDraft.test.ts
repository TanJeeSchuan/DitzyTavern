import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "../test-fixtures/render-hook";
import { boxSetups, boxes } from "../test-fixtures/box-setups";
import type { ConversationSummary } from "../conversation";
import { authorNoteSetup } from "../../boxes/author-note/contract";

const { useBoxSetupDraft } = await import("./useBoxSetupDraft");
const { queueConversationCommand } = await import("../conversation-command-runner");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const chat = (revision: number, note: string): ConversationSummary => ({
	id: 1, name: "Chat", revision, boxSetups: { ...boxSetups, "author-note": note }, boxes, boxVersions: {}, forkedFrom: null, background: null, cast: [],
	control: { humanParticipantId: null, modelParticipantId: null },
	controlValidity: { valid: false, reason: "missing-seat" },
	playable: false,
	capabilities: {
		compose: { available: false, reason: "conversation-not-playable" },
		generate: { available: false, reason: "conversation-not-playable" },
		swipe: { available: false, reason: "conversation-not-playable" },
	},
	activeGenerations: [],
});

const render = async (initial: ConversationSummary) => {
	let conversation = initial;
	const hook = await renderHook(() => useBoxSetupDraft("author-note", authorNoteSetup, {
		conversation, disabled: false, onConversationChange: (next) => { conversation = next; }, conflict: "Changed elsewhere.",
	}), new QueryClient());
	return { hook, change: (next: ConversationSummary) => { conversation = next; return hook.rerender(); } };
};

/** The server holds `server`: a save at its revision applies, any other conflicts. */
const serve = (server: ConversationSummary) => {
	const sent: number[] = [];
	globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
		const { expectedRevision, action } = JSON.parse(String(init?.body));
		sent.push(expectedRevision);
		return expectedRevision === server.revision
			? Response.json({ outcome: "applied", conversation: chat(server.revision + 1, action.setup) })
			: Response.json({ outcome: "conflict", expectedRevision, actualRevision: server.revision, currentConversation: server }, { status: 409 });
	}, { preconnect: () => {} });
	return sent;
};

describe("useBoxSetupDraft", () => {
	test("an untouched draft follows a setup saved elsewhere", async () => {
		const { hook, change } = await render(chat(1, "before"));
		await change(chat(2, "after"));
		expect(hook.current.draft).toBe("after");
		expect(hook.current.dirty).toBe(false);
	});

	test("an edited draft follows a newer revision that left its setup alone", async () => {
		const { hook, change } = await render(chat(1, "before"));
		await hook.act(async () => { hook.current.setDraft("mine"); });
		await change(chat(2, "before"));
		const sent = serve(chat(2, "before"));
		await hook.act(async () => { await hook.current.save(); });
		expect(sent).toEqual([2]);
		expect(hook.current.dirty).toBe(false);
	});

	test("an edited draft saves against the setup it started from, so a change elsewhere conflicts instead of being overwritten", async () => {
		const { hook, change } = await render(chat(1, "before"));
		await hook.act(async () => { hook.current.setDraft("mine"); });
		await change(chat(2, "theirs"));
		expect(hook.current.draft).toBe("mine");
		const sent = serve(chat(2, "theirs"));
		let saved = true;
		await hook.act(async () => { saved = await hook.current.save(); });
		expect(saved).toBe(false);
		expect(sent).toEqual([1]);
		expect(hook.current.conflict).toBe(true);
		expect(hook.current.draft).toBe("mine");
		expect(hook.current.saved).toBe("theirs");

		await hook.act(async () => { await hook.current.save(); });
		expect(sent).toEqual([1, 2]);
		expect(hook.current.conflict).toBe(false);
		expect(hook.current.dirty).toBe(false);
	});

	test("Load saved replaces a conflicted draft with the current setup", async () => {
		const { hook, change } = await render(chat(1, "before"));
		await hook.act(async () => { hook.current.setDraft("mine"); });
		await change(chat(2, "theirs"));
		serve(chat(2, "theirs"));
		await hook.act(async () => { await hook.current.save(); });
		await hook.act(async () => { hook.current.discard(); });
		expect(hook.current.draft).toBe("theirs");
		expect(hook.current.dirty).toBe(false);
	});

	test("a save that lost only to a newer revision is sent once more against it", async () => {
		const { hook } = await render(chat(1, "before"));
		await hook.act(async () => { hook.current.setDraft("mine"); });
		const sent = serve(chat(2, "before"));
		let saved = false;
		await hook.act(async () => { saved = await hook.current.save(); });
		expect(sent).toEqual([1, 2]);
		expect(saved).toBe(true);
		expect(hook.current.dirty).toBe(false);
	});

	test("a save queued behind another command still sends the revision its draft started from", async () => {
		const { hook, change } = await render(chat(1, "before"));
		await hook.act(async () => { hook.current.setDraft("mine"); });
		await change(chat(2, "theirs"));
		const ahead = Promise.withResolvers<number>();
		void queueConversationCommand(1, () => ahead.promise);
		const sent = serve(chat(3, "theirs"));
		let saving: Promise<boolean> = Promise.resolve(true);
		await hook.act(async () => { saving = hook.current.save(); });
		await hook.act(async () => { ahead.resolve(3); expect(await saving).toBe(false); });
		expect(sent).toEqual([1]);
		expect(hook.current.conflict).toBe(true);
		expect(hook.current.draft).toBe("mine");
	});
});
