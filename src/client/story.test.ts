import { describe, expect, test } from "bun:test";
import type { ChatHistoryPage } from "./chat-history";
import {
	EMPTY_VARIANT_PLACEHOLDER,
	classifyVariantSelection,
	confirmPreviewSelection,
	createStoryState,
	deriveRevisionWindow,
	displayedVariantId,
	isPreviewDownstream,
	previewNavigationNeedsConfirmation,
	moveActiveSwipe,
	reduceStory,
	visibleVariantContent,
	type StoryPreviewState,
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

const storyMessage = (
	id: number,
	position: number,
	authorParticipantId: number,
): StoryMessage => ({
	id,
	position,
	timestamp: `2026-01-01T00:00:0${position}.000Z`,
	authorName: authorParticipantId === 20 ? "Model" : "Writer",
	authorParticipantId,
	inCast: true,
	activeSwipe: 0,
	swipes: [
		{ id: id * 10, position: 1, content: `Selected ${id}`, empty: false },
		{ id: id * 10 + 1, position: 2, content: `Alternative ${id}`, empty: false },
	],
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

	test("derives the Revision window from the latest two model Messages", () => {
		const messages = [
			storyMessage(1, 1, 10),
			storyMessage(2, 2, 20),
			storyMessage(3, 3, 10),
			storyMessage(4, 4, 20),
			storyMessage(5, 5, 10),
			storyMessage(6, 6, 20),
			storyMessage(7, 7, 10),
		];

		expect([...deriveRevisionWindow(messages, 20)]).toEqual([4, 5, 6]);
		expect(deriveRevisionWindow(messages, null).size).toBe(0);
	});

	test("older Variant selection enters one local Preview with downstream skeleton state", () => {
		const state: StoryStateForPreview = {
			...createStoryState(),
			conversationId: 7,
			revision: 3,
			status: "ready",
			messages: [storyMessage(1, 1, 10), storyMessage(2, 2, 20)],
		};
		const selection = classifyVariantSelection(state, 1, 11, new Set([2]));
		expect(selection).toEqual({ kind: "preview", messageId: 1, variantId: 11 });
		expect(classifyVariantSelection(state, 2, 21, new Set([2]))).toEqual({
			kind: "immediate",
			messageId: 2,
			variantId: 21,
		});

		const previewing = reduceStory(state, {
			type: "preview-started",
			messageId: 1,
			variantId: 11,
		});
		expect(previewing.preview).toEqual({
			messageId: 1,
			targetPosition: 1,
			variantId: 11,
			priorVariantId: 10,
			noticeOpen: true,
		});
		// SAFETY: the fixture creates two Messages with ids 1 and 2 before the
		// reducer starts Preview mode, so the first lookup is defined here.
		expect(displayedVariantId(previewing.messages[0] as StoryMessage, previewing.preview)).toBe(11);
		// SAFETY: the same fixture creates the second Message before the reducer
		// starts Preview mode, so this lookup is defined here.
		expect(isPreviewDownstream(previewing.messages[1] as StoryMessage, previewing.preview)).toBe(true);
		expect(classifyVariantSelection(previewing, 1, 10, new Set([2]))).toEqual({ kind: "blocked" });
		const attemptedSelection = reduceStory(previewing, {
			type: "swipe-selected",
			messageId: 1,
			variantId: 10,
		});
		expect(attemptedSelection.messages[0]?.activeSwipe).toBe(0);
	});

	test("Preview only starts for a different Variant and navigation warns only for another Chat", () => {
		const state: StoryStateForPreview = {
			...createStoryState(),
			conversationId: 7,
			status: "ready",
			messages: [storyMessage(1, 1, 20)],
		};

		expect(
			reduceStory(state, { type: "preview-started", messageId: 1, variantId: 10 }),
		).toBe(state);
		expect(previewNavigationNeedsConfirmation(null, 7, 8)).toBe(false);
		expect(previewNavigationNeedsConfirmation(state.preview, 7, 7)).toBe(false);
		expect(previewNavigationNeedsConfirmation({
			messageId: 1,
			targetPosition: 1,
			variantId: 11,
			priorVariantId: 10,
			noticeOpen: true,
		}, 7, 8)).toBe(true);
	});

	test("closing and cancelling Preview restores the authoritative path without a command", () => {
		const state: StoryStateForPreview = {
			...createStoryState(),
			conversationId: 7,
			status: "ready",
			messages: [storyMessage(1, 1, 10)],
		};
		const previewing = reduceStory(state, {
			type: "preview-started",
			messageId: 1,
			variantId: 11,
		});
		const closed = reduceStory(previewing, { type: "preview-notice-closed" });
		expect(closed.preview?.noticeOpen).toBe(false);
		const cancelled = reduceStory(closed, { type: "preview-cancelled" });
		expect(cancelled.preview).toBeNull();
		expect(cancelled.messages[0]?.activeSwipe).toBe(0);
	});

	test("an authoritative history reload discards client-only Preview state", () => {
		const state: StoryStateForPreview = {
			...createStoryState(),
			conversationId: 7,
			revision: 3,
			status: "ready",
			messages: [storyMessage(1, 1, 10)],
		};
		const previewing = reduceStory(state, {
			type: "preview-started",
			messageId: 1,
			variantId: 11,
		});
		const reloaded = reduceStory(previewing, {
			type: "first-page",
			page: page({ messages: [message({ id: 1 })] }),
		});
		expect(reloaded.preview).toBeNull();
		expect(reloaded.messages[0]?.activeSwipe).toBe(0);
	});

	test("confirmation makes the previewed Variant authoritative and leaves later Messages intact", () => {
		const state: StoryStateForPreview = {
			...createStoryState(),
			conversationId: 7,
			status: "ready",
			messages: [storyMessage(1, 1, 10), storyMessage(2, 2, 20)],
		};
		const previewing = reduceStory(state, {
			type: "preview-started",
			messageId: 1,
			variantId: 11,
		});
		const confirmed = reduceStory(previewing, { type: "preview-confirmed" });
		expect(confirmed.preview).toBeNull();
		expect(confirmed.messages[0]?.activeSwipe).toBe(1);
		expect(confirmed.messages[1]).toEqual(state.messages[1]);
	});

	test("confirmation transport sends once only for the matching Preview", async () => {
		const preview: StoryPreviewState = {
			messageId: 1,
			targetPosition: 1,
			variantId: 11,
			priorVariantId: 10,
			noticeOpen: true,
		};
		const requests: number[] = [];
		const request = {
			conversationId: 7,
			expectedRevision: 3,
			messageId: 1,
			variantId: 11,
		};
		const sent = await confirmPreviewSelection(preview, request, async (value) => {
			requests.push(value.variantId);
			return "applied" as const;
		});
		expect(sent).toEqual({ status: "sent", result: "applied" });
		expect(requests).toEqual([11]);

		const notSent = await confirmPreviewSelection(null, request, async () => {
			requests.push(99);
			return "applied" as const;
		});
		expect(notSent).toEqual({ status: "not-sent" });
		expect(requests).toEqual([11]);
	});
});

type StoryStateForPreview = ReturnType<typeof createStoryState> & {
	messages: StoryMessage[];
};
