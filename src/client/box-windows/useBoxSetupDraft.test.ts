import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "../test-fixtures/render-hook";
import { boxSetups, boxes } from "../test-fixtures/box-setups";
import type { ConversationSummary } from "../conversation";
import { authorNoteSetup } from "../../boxes/author-note/contract";

const { useBoxSetupDraft } = await import("./useBoxSetupDraft");

const chat = (revision: number, note: string): ConversationSummary => ({
	id: 1, name: "Chat", revision, boxSetups: { ...boxSetups, "author-note": note }, boxes, forkedFrom: null, background: null, cast: [],
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
	const hook = await renderHook(() => useBoxSetupDraft("author-note", authorNoteSetup, { conversation, disabled: false, onConversationChange: () => {}, conflict: "" }), new QueryClient());
	return { hook, change: (next: ConversationSummary) => { conversation = next; return hook.rerender(); } };
};

describe("useBoxSetupDraft", () => {
	test("an untouched draft follows a setup saved elsewhere", async () => {
		const { hook, change } = await render(chat(1, "before"));
		await change(chat(2, "after"));
		expect(hook.current.draft).toBe("after");
	});

	test("an edited draft keeps its edits when the setup is saved elsewhere", async () => {
		const { hook, change } = await render(chat(1, "before"));
		await hook.act(async () => { hook.current.setDraft("mine"); });
		await change(chat(2, "after"));
		expect(hook.current.draft).toBe("mine");
	});
});
