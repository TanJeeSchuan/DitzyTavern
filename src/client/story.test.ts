import { describe, expect, test } from "bun:test";
import type { ChatHistoryPage } from "./chat-history";
import {
	EMPTY_VARIANT_PLACEHOLDER,
	createStoryState,
	moveActiveSwipe,
	reduceStory,
	visibleVariantContent,
	type StoryMessage,
} from "./story";

// Focused client-state tests without a frontend framework: page
// accumulation, selected-Variant updates, empty placeholders, and the
// conversation switch reset. The view feeds transport-typed pages in and
// reads pure state out.

const page = (
	overrides: Partial<ChatHistoryPage> = {},
): ChatHistoryPage => ({
	conversationId: 7,
	name: "Lantern House",
	revision: 3,
	cast: [{ id: 1, position: 1, name: "Writer" }],
	page: {
		index: 1,
		pageSize: 2,
		totalMessages: 4,
		totalPages: 2,
		hasOlder: true,
		hasNewer: false,
	},
	messages: [],
	...overrides,
});

const message = (
	overrides: Partial<ChatHistoryPage["messages"][number]> = {},
): ChatHistoryPage["messages"][number] => ({
	id: 10,
	position: 1,
	timestamp: "2026-01-01T00:00:00.000Z",
	author: { participantId: 1, capturedName: "Writer", inCast: true },
	variants: [
		{ id: 100, position: 1, content: "Once", timestamp: "2026-01-01T00:00:00.000Z", selected: true },
	],
	...overrides,
});

describe("story reading state", () => {
	test("accumulates pages without overlap and keeps stable chronology", () => {
		const opened = reduceStory(createStoryState(), {
			type: "chat-opened",
			conversationId: 7,
		});
		// The first page is the latest window of history.
		const first = reduceStory(opened, {
			type: "first-page",
			page: page({
				messages: [message({ id: 12, position: 3 }), message({ id: 13, position: 4 })],
			}),
		});
		expect(first.status).toBe("ready");
		expect(first.messages.map((entry) => entry.id)).toEqual([12, 13]);
		expect(first.page?.hasOlder).toBe(true);

		// An older page arrives and prepends above the accumulated window.
		const second = reduceStory(first, {
			type: "next-page-arrived",
			page: page({
				page: {
					index: 2,
					pageSize: 2,
					totalMessages: 4,
					totalPages: 2,
					hasOlder: false,
					hasNewer: true,
				},
				messages: [message({ id: 10, position: 1 }), message({ id: 11, position: 2 })],
			}),
		});
		expect(second.messages.map((entry) => entry.id)).toEqual([10, 11, 12, 13]);
		expect(second.page?.hasOlder).toBe(false);
	});

	test("a repeated page appends no duplicates", () => {
		const state = reduceStory(
			reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 }),
			{
				type: "first-page",
				page: page({ messages: [message({ id: 10 })] }),
			},
		);
		const refreshed = reduceStory(state, {
			type: "next-page-arrived",
			page: page({
				page: {
					index: 1,
					pageSize: 2,
					totalMessages: 4,
					totalPages: 2,
					hasOlder: true,
					hasNewer: false,
				},
				messages: [message({ id: 10 })],
			}),
		});
		expect(refreshed.messages).toHaveLength(1);
	});

	test("swipe selection updates the active Variant position locally", () => {
		const state = reduceStory(
			reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 }),
			{
				type: "first-page",
				page: page({
					messages: [
						message({
							id: 10,
							variants: [
								{
									id: 100,
									position: 1,
									content: "First",
									timestamp: "2026-01-01T00:00:00.000Z",
									selected: true,
								},
								{
									id: 101,
									position: 2,
									content: "Second",
									timestamp: "2026-01-01T00:00:01.000Z",
									selected: false,
								},
							],
						}),
					],
				}),
			},
		);
		expect(state.messages[0]?.activeSwipe).toBe(0);

		const updated = reduceStory(state, {
			type: "swipe-selected",
			messageId: 10,
			variantId: 101,
		});
		expect(updated.messages[0]?.activeSwipe).toBe(1);
		// Other Messages and the selection of the visible content follow.
		// SAFETY: the fixture above gave the Message exactly two Variants and
		// selected the second, so index 1 exists on the updated Message.
		expect(visibleVariantContent(updated.messages[0]?.swipes[1] as StoryMessage["swipes"][number])).toBe(
			"Second",
		);
	});

	test("empty Variants are separate navigable positions with a presentation-only placeholder", () => {
		const state = reduceStory(
			reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 }),
			{
				type: "first-page",
				page: page({
					messages: [
						message({
							id: 10,
							variants: [
								{
									id: 100,
									position: 1,
									content: "Once",
									timestamp: "2026-01-01T00:00:00.000Z",
									selected: false,
								},
								{
									id: 101,
									position: 2,
									content: "Once",
									timestamp: "2026-01-01T00:00:01.000Z",
									selected: false,
								},
								{
									id: 102,
									position: 3,
									content: "",
									timestamp: "2026-01-01T00:00:02.000Z",
									selected: true,
								},
							],
						}),
					],
				}),
			},
		);
		const swipes = state.messages[0]?.swipes ?? [];
		expect(swipes).toHaveLength(3);
		expect(state.messages[0]?.activeSwipe).toBe(2);
		// The duplicate and empty alternatives remain separate positions.
		expect(swipes.map((variant) => variant.empty)).toEqual([false, false, true]);
		// The placeholder substitutes rendering only; the stored text stays
		// exactly empty in the model (never rewritten).
		// SAFETY: the toHaveLength assertion above guarantees the first
		// Message's third Variant exists before reading it.
		expect(visibleVariantContent(swipes[2] as StoryMessage["swipes"][number])).toBe(
			EMPTY_VARIANT_PLACEHOLDER,
		);
		expect(swipes[2]?.content).toBe("");
	});

	test("positional swipe movement stays within the Variant range", () => {
		const state = reduceStory(
			reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 }),
			{
				type: "first-page",
				page: page({
					messages: [
						message({
							id: 10,
							variants: [100, 101].map((id, index) => ({
								id,
								position: index + 1,
								content: `Variant ${index + 1}`,
								timestamp: "2026-01-01T00:00:00.000Z",
								selected: index === 0,
							})),
						}),
					],
				}),
			},
		);
		const messageState = state.messages[0];
		expect(messageState).toBeDefined();
		// SAFETY: the toBeDefined assertion above guarantees the first Message
		// exists before casting it, and the fixture gave it exactly two
		// Variants so index 1 stays in range.
		const existing = messageState as StoryMessage;
		expect(moveActiveSwipe(existing, 1)).toBe(1);
		expect(moveActiveSwipe(existing, -1)).toBe(0);
		// SAFETY: the fixture gave the Message exactly two Variants, so the
		// last position with activeSwipe 1 is in range.
		const last = { ...existing, activeSwipe: 1 };
		expect(moveActiveSwipe(last, 1)).toBe(1);
		expect(moveActiveSwipe(last, -1)).toBe(0);
	});

	test("opening a different Chat resets the accumulated history", () => {
		const state = reduceStory(
			reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 }),
			{
				type: "first-page",
				page: page({ messages: [message({ id: 10 })] }),
			},
		);
		const switched = reduceStory(state, {
			type: "chat-opened",
			conversationId: 8,
		});
		expect(switched.conversationId).toBe(8);
		expect(switched.messages).toEqual([]);
		expect(switched.status).toBe("loading-first");
	});
});