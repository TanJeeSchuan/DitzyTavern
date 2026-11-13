import { describe, expect, test } from "bun:test";
import type { ChatHistoryPage } from "./chat-history";
import {
	EMPTY_VARIANT_PLACEHOLDER,
	canOfferSiblingGeneration,
	classifyVariantSelection,
	createStoryState,
	displayedVariantId,
	isPreviewDownstream,
	previewNavigationNeedsConfirmation,
	reduceStory,
	reusesTrailingHumanMessage,
	shownMessage,
	visibleVariantContent,
	type StoryAction,
	type StoryPreviewState,
	type StoryMessage,
	type StoryState,
} from "./story";
import { createVariantStreams, streamedVariant, type VariantObservation } from "./story/variant-streams";

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

const readyStory = (state: StoryState) => {
	if (state.status !== "ready") throw new Error("Story was not ready.");
	return state;
};
const createReadyStory = () => readyStory(reduceStory(
	reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 }),
	{ type: "window-received", page: page() },
));

// @approved
//  The story as the writer reads it: pages through the reducer, stream observations through the Variant streams.
const reader = (initial = reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 })) => {
	const streams = createVariantStreams();
	let state = initial;
	const placed = ({ messageId, variantId }: VariantObservation) =>
		state.messages.find((entry) => entry.id === messageId)?.swipes.find((variant) => variant.id === variantId);
	return {
		get state() { return state; },
		receive(received: ChatHistoryPage, activeGenerationIds?: number[]) {
			const action: Extract<StoryAction, { type: "window-received" }> = { type: "window-received", page: received };
			if (activeGenerationIds !== undefined) action.activeGenerationIds = activeGenerationIds;
			state = reduceStory(state, action);
		},
		observe(...observations: VariantObservation[]) {
			for (const observation of observations) streams.observe(observation, placed(observation));
		},
		shown(variantId: number) {
			const variant = state.messages.flatMap((entry) => entry.swipes).find((entry) => entry.id === variantId);
			return variant && streamedVariant(variant, streams.get(variantId));
		},
	};
};
const target = { messageId: 10, variantId: 100, generationId: 55 };
const append = (eventId: number, text: string, stream: "content" | "reasoning" = "content", at = target): VariantObservation =>
	({ ...at, eventId, mode: "append", stream, text });
const replace = (eventId: number, content: string, reasoning = "", at = target): VariantObservation =>
	({ ...at, eventId, mode: "replace", content, reasoning });

const message = (
	overrides: Partial<Omit<
		ChatHistoryPage["messages"][number],
		"modelParticipantIdAtCreation" | "continuable" | "swipe"
	>> = {},
): ChatHistoryPage["messages"][number] => ({
	id: 10,
	position: 1,
	timestamp: "2026-01-01T00:00:00.000Z",
	authorRole: "model",
	modelParticipantIdAtCreation: null,
	continuable: true,
	swipe: { eligible: true, reason: null },
	author: { participantId: 1, capturedName: "Writer", inCast: true },
	variants: [
		{ id: 100, position: 1, content: "Once", empty: false, hasReasoning: false, timestamp: "2026-01-01T00:00:00.000Z", selected: true },
	],
	moves: {},
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
	authorRole: authorParticipantId === 20 ? "model" : "human",
	modelParticipantIdAtCreation: null,
	continuable: true,
	// Server-derived capability carried by history: eligible unless a test
	// overrides it with the server's typed ineligibility.
	swipe: { eligible: true, reason: null },
	inCast: true,
	activeSwipe: 0,
	moves: {},
	swipes: [
		{ id: id * 10, position: 1, content: `Selected ${id}`, empty: false, hasReasoning: false },
		{ id: id * 10 + 1, position: 2, content: `Alternative ${id}`, empty: false, hasReasoning: false },
	],
});

describe("story reading state", () => {
	test("a failed loaded history request can retry paging", () => {
		const failed = reduceStory(createReadyStory(), { type: "history-failed" });
		const retry = reduceStory(failed, { type: "load-more-started" });
		expect(retry).toMatchObject({ status: "ready", conversationId: 7, revision: 3, loadingMore: true });
	});

	test("a failed loaded history request retains Conversation and revision guards", () => {
		const failed = reduceStory(createReadyStory(), { type: "history-failed" });
		expect(reduceStory(failed, { type: "window-received", page: page({ conversationId: 99 }) })).toBe(failed);
		expect(reduceStory(failed, { type: "window-received", page: page({ revision: 2 }) })).toBe(failed);
	});

	test("offers New Swipe on a server-eligible Message and honors the active response position", () => {
		const olderEligible: StoryMessage = storyMessage(10, 1, 20);
		const newerEligible: StoryMessage = storyMessage(11, 2, 20);
		expect(canOfferSiblingGeneration({
			message: olderEligible,
			playable: true,
			previewActive: false,
			activeGenerationMessageIds: [],
		})).toBe(true);
		expect(canOfferSiblingGeneration({
			message: olderEligible,
			playable: true,
			previewActive: false,
			activeGenerationMessageIds: [olderEligible.id],
		})).toBe(true);
		expect(canOfferSiblingGeneration({
			message: olderEligible,
			playable: true,
			previewActive: false,
			activeGenerationMessageIds: [newerEligible.id],
		})).toBe(false);
		expect(canOfferSiblingGeneration({
			message: olderEligible,
			playable: true,
			previewActive: true,
			activeGenerationMessageIds: [],
		})).toBe(false);
		expect(canOfferSiblingGeneration({
			message: olderEligible,
			playable: false,
			previewActive: false,
			activeGenerationMessageIds: [],
		})).toBe(false);
	});

	test("follows the server-derived Swipe eligibility instead of Message authorship", () => {
		// Eligibility is the server's canonical historical-pair rule
		// (ADR-0003), carried by history as a required capability object: an
		// opening Message with a trustworthy captured pair is eligible even
		// though it is not model-authored.
		const opening = storyMessage(12, 1, 1);
		expect(canOfferSiblingGeneration({
			message: opening,
			playable: true,
			previewActive: false,
			activeGenerationMessageIds: [],
		})).toBe(true);
	});

	test("refuses a Message the server marked Swipe-ineligible", () => {
		// The client never reconstructs eligibility: a captured generation-time
		// identity is not the server's answer, so a model-authored Message
		// whose historical pair is unavailable stays ineligible.
		const unavailable: StoryMessage = {
			...storyMessage(13, 1, 20),
			modelParticipantIdAtCreation: 20,
			swipe: { eligible: false, reason: "missing-historical-context" },
		};
		expect(canOfferSiblingGeneration({
			message: unavailable,
			playable: true,
			previewActive: false,
			activeGenerationMessageIds: [],
		})).toBe(false);
	});

	test("swipe selection updates the active Variant position locally", () => {
		const state = reduceStory(
			reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 }),
			{
				type: "window-received",
				page: page({
					messages: [
						message({
							id: 10,
							variants: [
								{
									id: 100,
									position: 1,
									content: "First",
									empty: false,
									hasReasoning: false,
									timestamp: "2026-01-01T00:00:00.000Z",
									selected: true,
								},
								{
									id: 101,
									position: 2,
									content: "Second",
									empty: false,
									hasReasoning: false,
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
				type: "window-received",
				page: page({
					messages: [
						message({
							id: 10,
							variants: [
								{
									id: 100,
									position: 1,
									content: "Once",
									empty: false,
									hasReasoning: false,
									timestamp: "2026-01-01T00:00:00.000Z",
									selected: false,
								},
								{
									id: 101,
									position: 2,
									content: "Once",
									empty: false,
									hasReasoning: false,
									timestamp: "2026-01-01T00:00:01.000Z",
									selected: false,
								},
								{
									id: 102,
									position: 3,
									content: "",
									empty: true,
									hasReasoning: false,
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

	test("opening a different Chat resets the accumulated history", () => {
		const state = reduceStory(
			reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 }),
			{
				type: "window-received",
				page: page({ messages: [message({ id: 10 })] }),
			},
		);
		const switched = reduceStory(state, {
			type: "chat-opened",
			conversationId: 8,
		});
		expect(switched).toMatchObject({ conversationId: 8 });
		expect(switched.messages).toEqual([]);
		expect(switched.status).toBe("loading-first");
	});

	test("older Variant selection enters one local Preview with downstream read-only state", () => {
		const state: StoryStateForPreview = {
			...createReadyStory(),
			conversationId: 7,
			revision: 3,
			status: "ready",
			messages: [storyMessage(1, 1, 10), storyMessage(2, 2, 20)],
		};
		const selection = classifyVariantSelection(state, 1, 11);
		expect(selection).toEqual({ kind: "preview", messageId: 1, variantId: 11 });
		expect(classifyVariantSelection(state, 2, 21)).toEqual({
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
		});
		// SAFETY: the fixture creates two Messages with ids 1 and 2 before the
		// reducer starts Preview mode, so the first lookup is defined here.
		expect(displayedVariantId(previewing.messages[0] as StoryMessage, previewing.preview)).toBe(11);
		// SAFETY: the same fixture creates the second Message before the reducer
		// starts Preview mode, so this lookup is defined here.
		expect(isPreviewDownstream(previewing.messages[1] as StoryMessage, previewing.preview)).toBe(true);
		expect(classifyVariantSelection(previewing, 1, 10)).toEqual({ kind: "blocked" });
	});

	test("the previewed Message's Variants can be switched freely while Preview stays local", () => {
		const target: StoryMessage = {
			...storyMessage(1, 1, 10),
			swipes: [
				{ id: 10, position: 1, content: "Selected", empty: false, hasReasoning: false },
				{ id: 11, position: 2, content: "Second", empty: false, hasReasoning: false },
				{ id: 12, position: 3, content: "Third", empty: false, hasReasoning: false },
			],
		};
		const state: StoryStateForPreview = {
			...createReadyStory(),
			conversationId: 7,
			revision: 3,
			status: "ready",
			messages: [target, storyMessage(2, 2, 20)],
		};
		const previewing = reduceStory(state, {
			type: "preview-started",
			messageId: 1,
			variantId: 11,
		});

		// Swiping forward moves the local Preview to the next Variant and keeps
		// the authoritative selection as the cancellation anchor.
		const retargeted = reduceStory(previewing, {
			type: "preview-retargeted",
			messageId: 1,
			variantId: 12,
		});
		expect(retargeted.preview).toEqual({
			messageId: 1,
			targetPosition: 1,
			variantId: 12,
			priorVariantId: 10,
		});
		// SAFETY: the fixture creates Message 1 before the retarget, so this
			// lookup is defined here.
		expect(displayedVariantId(retargeted.messages[0] as StoryMessage, retargeted.preview)).toBe(12);

		// Retargeting another Message or an unknown Variant changes nothing.
		expect(
			reduceStory(retargeted, { type: "preview-retargeted", messageId: 2, variantId: 21 }),
		).toBe(retargeted);
		expect(
			reduceStory(retargeted, { type: "preview-retargeted", messageId: 1, variantId: 99 }),
		).toBe(retargeted);

		// Cycling back onto the server-selected Variant ends the Preview without
		// touching any Message state.
		const restored = reduceStory(retargeted, {
			type: "preview-retargeted",
			messageId: 1,
			variantId: 10,
		});
		expect(restored.preview).toBeNull();
		expect(restored.messages[0]?.activeSwipe).toBe(0);
		expect(restored.messages).toEqual(state.messages);
	});

	test("Preview only starts for a different Variant and navigation warns only for another Chat", () => {
		const state: StoryStateForPreview = {
			...createReadyStory(),
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
		}, 7, 8)).toBe(true);
	});

	test("cancelling Preview restores the authoritative path without a command", () => {
		const state: StoryStateForPreview = {
			...createReadyStory(),
			conversationId: 7,
			status: "ready",
			messages: [storyMessage(1, 1, 10)],
		};
		const previewing = reduceStory(state, {
			type: "preview-started",
			messageId: 1,
			variantId: 11,
		});
		const cancelled = reduceStory(previewing, { type: "preview-cancelled" });
		expect(cancelled.preview).toBeNull();
		expect(cancelled.messages[0]?.activeSwipe).toBe(0);
	});

	test("an authoritative history reload discards client-only Preview state", () => {
		const state: StoryStateForPreview = {
			...createReadyStory(),
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
			type: "window-received",
			page: page({ messages: [message({ id: 1 })] }),
		});
		expect(reloaded.preview).toBeNull();
		expect(reloaded.messages[0]?.activeSwipe).toBe(0);
	});

	test("confirming a second Message keeps the first confirmation shown", () => {
		const state: StoryStateForPreview = {
			...createReadyStory(),
			conversationId: 7,
			status: "ready",
			messages: [storyMessage(1, 1, 10), storyMessage(2, 2, 20), storyMessage(3, 3, 10)],
		};
		const confirmFirst = reduceStory(reduceStory(state, { type: "preview-started", messageId: 1, variantId: 11 }), { type: "preview-confirmed" });
		const confirmBoth = reduceStory(reduceStory(confirmFirst, { type: "preview-started", messageId: 2, variantId: 21 }), { type: "preview-confirmed" });
		expect([...confirmBoth.requestedSelections]).toEqual([[1, 11], [2, 21]]);
	});

	test("a confirmation that applies while another Message is previewed settles its Message", () => {
		const state: StoryStateForPreview = {
			...createReadyStory(),
			conversationId: 7,
			status: "ready",
			messages: [storyMessage(1, 1, 10), storyMessage(2, 2, 20), storyMessage(3, 3, 10)],
		};
		const confirmed = reduceStory(reduceStory(state, { type: "preview-started", messageId: 1, variantId: 11 }), { type: "preview-confirmed" });
		const previewingOther = reduceStory(confirmed, { type: "preview-started", messageId: 2, variantId: 21 });
		const applied = reduceStory(previewingOther, { type: "swipe-selected", messageId: 1, variantId: 11 });
		expect(applied.requestedSelections.size).toBe(0);
		expect(applied.messages[0]?.activeSwipe).toBe(1);
		expect(applied.preview?.messageId).toBe(2);
	});

	test("confirmation makes the previewed Variant authoritative and leaves later Messages intact", () => {
		const state: StoryStateForPreview = {
			...createReadyStory(),
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
		const [confirmedMessage] = confirmed.messages;
		expect(confirmedMessage && displayedVariantId(confirmedMessage, null, confirmed.requestedSelections)).toBe(11);
		const applied = reduceStory(confirmed, { type: "swipe-selected", messageId: 1, variantId: 11 });
		expect(applied.requestedSelections.size).toBe(0);
		expect(applied.messages[0]?.activeSwipe).toBe(1);
		expect(applied.messages[1]).toEqual(state.messages[1]);
	});
});

describe("streaming Provisional Variant content", () => {
	const provisional = { id: 100, position: 1, content: "", empty: true, hasReasoning: false, timestamp: "2026-01-01T00:00:00.000Z", selected: true,
		liveGeneration: { generationId: 55, eventId: 0, content: "", reasoning: "" } };
	const stateWithProvisional = () => {
		const story = reader();
		story.receive(page({ revision: 4, messages: [message({ id: 10, variants: [provisional] })] }));
		return story;
	};

	for (const observedLive of [false, true]) test(`terminal history rejects later replay after live history was ${observedLive ? "observed" : "not observed"}`, () => {
		const story = observedLive ? stateWithProvisional() : reader();
		const content = "The tide turns against the pier.\n\nThen the";
		story.receive(page({ revision: 5, messages: [message({ id: 10, variants: [{
			id: 100, position: 1, content, empty: false, hasReasoning: true, timestamp: "2026-01-01T00:00:00.000Z", selected: true,
		}] })] }), []);
		for (const [index, text] of ["The tide turns against the pier.\n\n", "Then the"].entries()) {
			story.observe(append(index + 1, text));
			expect(story.shown(100)?.content).toBe(content);
		}
		story.observe(replace(3, "Stale checkpoint", "Stale thought"));
		expect(story.shown(100)).toMatchObject({ content, reasoning: "", hasReasoning: true });
	});

	test("Content deltas append to the Provisional Variant and update the empty placeholder", () => {
		const story = stateWithProvisional();
		story.observe(append(1, "Once upon "), append(2, "a time"));
		expect(story.shown(100)).toMatchObject({ content: "Once upon a time", empty: false });
	});

	test("an authoritative Content replace overwrites the accumulated text", () => {
		const story = stateWithProvisional();
		story.observe(append(1, "Stale tail"), replace(2, "Authoritative"));
		expect(story.shown(100)?.content).toBe("Authoritative");
	});

	test("Reasoning Content streams separately, and authoritative history hands it to the Variant text read", () => {
		const story = stateWithProvisional();
		story.observe(append(1, "First thought. ", "reasoning"));
		expect(story.shown(100)).toMatchObject({ content: "", reasoning: "First thought. ", hasReasoning: true });
		story.observe(replace(2, "Finished.", "Authoritative thought."));
		expect(story.shown(100)?.reasoning).toBe("Authoritative thought.");

		story.receive(page({ revision: 5, messages: [message({ id: 10, variants: [
			{ id: 100, position: 1, content: "Finished.", empty: false, hasReasoning: true, timestamp: "2026-01-01T00:00:00.000Z", selected: true },
		] })] }));
		// A stream that missed its end must not stand in for the persisted text.
		expect(story.shown(100)).toMatchObject({ content: "Finished.", reasoning: "", hasReasoning: true });
	});

	test("a Variant the page stops carrying is read again, not kept from the earlier page", () => {
		const variant = (id: number, content: string, selected: boolean): ChatHistoryPage["messages"][number]["variants"][number] => {
			const entry: ChatHistoryPage["messages"][number]["variants"][number] = { id, position: id - 99, empty: false, hasReasoning: false, timestamp: "2026-01-01T00:00:00.000Z", selected };
			if (selected) entry.content = content;
			return entry;
		};
		const at = (revision: number, selectedId: number) => page({ revision, messages: [message({ id: 10, variants: [
			variant(100, "Before the other tab's edit.", selectedId === 100),
			variant(101, "Other.", selectedId === 101),
		] })] });
		const story = reader();
		story.receive(at(4, 100));
		story.receive(at(6, 101));
		expect(story.shown(100)?.content).toBeNull();
		expect(story.shown(101)?.content).toBe("Other.");
	});

	const unplaced = { messageId: 11, variantId: 110, generationId: 55 };
	const placing = (live: { eventId: number; content: string } | null, content = "") => {
		const variant: ChatHistoryPage["messages"][number]["variants"][number] = {
			id: 110, position: 1, content, empty: content === "", hasReasoning: false, timestamp: "2026-01-01T00:00:00.000Z", selected: true,
		};
		if (live) variant.liveGeneration = { generationId: 55, eventId: live.eventId, content: live.content, reasoning: "" };
		return page({ messages: [message({ id: 11, variants: [variant] })] });
	};

	test("stream events that land before the page placing their Variant show once it arrives", () => {
		const early = () => {
			const story = reader();
			story.observe(append(1, "The tide.", "content", unplaced), append(2, " The lights.", "content", unplaced), append(3, " Then the", "content", unplaced));
			return story;
		};
		const live = early();
		live.receive(placing({ eventId: 0, content: "" }), [55]);
		expect(live.shown(110)?.content).toBe("The tide. The lights. Then the");

		const checkpointed = early();
		checkpointed.receive(placing({ eventId: 2, content: "The tide. The lights." }), [55]);
		expect(checkpointed.shown(110)?.content).toBe("The tide. The lights. Then the");

		const finished = early();
		finished.receive(placing(null, "The tide. The lights. Then the end."));
		expect(finished.shown(110)?.content).toBe("The tide. The lights. Then the end.");
	});

	test("held stream events survive a jump back to the latest Messages, and a snapshot supersedes earlier ones", () => {
		const detached = () => {
			const story = reader();
			story.receive(page({ page: { index: 2, pageSize: 2, totalMessages: 4, totalPages: 2, hasOlder: false, hasNewer: true } }));
			story.observe(append(1, "One.", "content", unplaced), append(2, " Two.", "content", unplaced), append(3, " Three.", "content", unplaced));
			return story;
		};
		const latest = placing({ eventId: 1, content: "One." });
		const returned = detached();
		returned.receive(latest, [55]);
		expect(returned.shown(110)?.content).toBe("One. Two. Three.");

		const snapshot = detached();
		snapshot.observe(replace(4, "One. Two. Three. Four.", "", unplaced));
		snapshot.receive(latest, [55]);
		expect(snapshot.shown(110)?.content).toBe("One. Two. Three. Four.");

		const staleSnapshot = detached();
		staleSnapshot.observe(replace(1, "One.", "", unplaced));
		staleSnapshot.receive(latest, [55]);
		expect(staleSnapshot.shown(110)?.content).toBe("One. Two. Three.");
	});

	test("history checkpoint and replay resume share one ordered projection", () => {
		const story = reader();
		story.receive(page({ messages: [message({ id: 10, variants: [{
			id: 100, position: 1, content: "Saved", empty: false, hasReasoning: false, timestamp: "2026-01-01T00:00:00.000Z", selected: true,
			liveGeneration: { generationId: 55, eventId: 1, content: "Saved", reasoning: "" },
		}] })] }), [55]);
		story.observe(append(1, "Saved"));
		expect(story.shown(100)?.content).toBe("Saved");
		story.observe(append(2, " next"));
		expect(story.shown(100)?.content).toBe("Saved next");
	});
});

type StoryStateForPreview = ReturnType<typeof createStoryState> & {
	messages: StoryMessage[];
};


describe("detached story windows", () => {
	const history = (index: number, positions: number[], totalMessages = 8) => page({
		page: { index, pageSize: 2, totalMessages, totalPages: Math.ceil(totalMessages / 2), hasOlder: index < Math.ceil(totalMessages / 2), hasNewer: index > 1 },
		messages: positions.map((position) => message({ id: position, position, variants: [
			{ id: position * 10, position: 1, content: `Message ${position}`, empty: false, hasReasoning: false, timestamp: "", selected: true },
			{ id: position * 10 + 1, position: 2, content: "Alternative", empty: false, hasReasoning: false, timestamp: "", selected: false },
		] })),
	});
	const open = () => reduceStory(reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 }), { type: "window-received", page: history(1, [7, 8]) });
	const detach = () => reduceStory(open(), { type: "window-received", page: history(3, [3, 4]) });
	const detachLive = () => {
		const page = history(3, [3, 4]);
		page.messages[1]!.variants[0]!.liveGeneration = { generationId: 2, eventId: 0, content: "Message 4", reasoning: "" };
		return reduceStory(open(), { type: "window-received", page, activeGenerationIds: [2] });
	};

	test("a source jump replaces the latest window with one page", () => {
		const state = detach();
		expect(state.messages.map(({ id }) => id)).toEqual([3, 4]);
		expect(readyStory(state).page).toMatchObject({ index: 3, hasNewer: true, hasOlder: true });
	});

	test("a refresh preserves Preview until its Variant or Message disappears", () => {
		const previewing = reduceStory(detach(), { type: "preview-started", messageId: 3, variantId: 31 });
		const refreshed = reduceStory(previewing, { type: "window-received", page: history(3, [3, 4]) });
		expect(refreshed.preview).toEqual(previewing.preview);
		const withoutVariant = history(3, [3, 4]);
		withoutVariant.messages[0]!.variants.pop();
		expect(reduceStory(refreshed, { type: "window-received", page: withoutVariant }).preview).toBeNull();
		expect(reduceStory(refreshed, { type: "window-received", page: history(3, [4]) }).preview).toBeNull();
		const selectedElsewhere = history(3, [3, 4]);
		selectedElsewhere.messages[0]!.variants[0]!.selected = false;
		selectedElsewhere.messages[0]!.variants.push({ id: 32, position: 3, content: "Third", empty: false, hasReasoning: false, timestamp: "", selected: true });
		expect(reduceStory(refreshed, { type: "window-received", page: selectedElsewhere }).preview?.priorVariantId).toBe(32);
		selectedElsewhere.messages[0]!.variants[2]!.selected = false;
		selectedElsewhere.messages[0]!.variants[1]!.selected = true;
		expect(reduceStory(refreshed, { type: "window-received", page: selectedElsewhere }).preview).toBeNull();
	});

	test("live observations apply to a Message in a detached window", () => {
		const story = reader(detachLive());
		story.observe(append(1, " continues", "content", { messageId: 4, variantId: 40, generationId: 2 }));
		expect(story.shown(40)?.content).toBe("Message 4 continues");
	});

	test("authoritative refreshes update only loaded Messages and preserve a newer live checkpoint", () => {
		const story = reader(detachLive());
		story.observe(append(2, " streaming", "content", { messageId: 4, variantId: 40, generationId: 2 }));
		const refreshed = history(2, [3, 4], 7);
		refreshed.messages[1]!.variants[0]!.liveGeneration = { generationId: 2, eventId: 1, content: "Message 4", reasoning: "" };
		story.receive(refreshed, [2]);
		expect(story.state.messages.map(({ id }) => id)).toEqual([3, 4]);
		expect(story.shown(40)?.content).toBe("Message 4 streaming");
		const final = history(2, [3, 4], 7);
		final.messages[1]!.variants[0]!.content = "Finished";
		story.receive(final);
		expect(story.shown(40)?.content).toBe("Finished");
		expect(readyStory(story.state).page.hasNewer).toBe(true);
	});

	test("a detached final visible Message needs Swipe preview", () => {
		expect(classifyVariantSelection(detach(), 4, 41).kind).toBe("preview");
		expect(classifyVariantSelection(open(), 8, 81).kind).toBe("immediate");
	});
});

describe("Requested Send", () => {
	const opened = () => reduceStory(reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 }), {
		type: "window-received",
		page: page({ messages: [message()] }),
	});

	test("stays until a page places its accepted Provisional Variant", () => {
		const requested = reduceStory(opened(), { type: "generation-requested", request: { kind: "send", content: "Twice" } });
		const accepted = reduceStory(requested, { type: "generation-request-accepted", generationId: 9, variantId: 201, sentRevision: 3 });
		const stale = reduceStory(accepted, { type: "window-received", page: page({ revision: 4, messages: [message()] }) });
		expect(stale.requestedGeneration).toEqual({ request: { kind: "send", content: "Twice" }, accepted: { generationId: 9, variantId: 201, sentRevision: 3 } });

		const placed = reduceStory(stale, { type: "window-received", page: page({ revision: 5, messages: [
			message(),
			message({ id: 20, position: 2, variants: [{ id: 201, position: 1, content: "", empty: true, hasReasoning: false, timestamp: "2026-01-01T00:00:01.000Z", selected: true }] }),
		] }) });
		expect(placed.requestedGeneration).toBeNull();
	});

	test("retires once authority shows its accepted Generation ended without placing a Variant", () => {
		const requested = reduceStory(opened(), { type: "generation-requested", request: { kind: "send", content: "Twice" } });
		const accepted = reduceStory(requested, { type: "generation-request-accepted", generationId: 9, variantId: 201, sentRevision: 3 });
		const sentBefore = reduceStory(accepted, { type: "window-received", page: page({ revision: 3, messages: [message()] }), activeGenerationIds: [] });
		expect(sentBefore.requestedGeneration).not.toBeNull();
		const running = reduceStory(sentBefore, { type: "window-received", page: page({ revision: 4, messages: [message()] }), activeGenerationIds: [9] });
		expect(running.requestedGeneration).not.toBeNull();
		const ended = reduceStory(running, { type: "window-received", page: page({ revision: 5, messages: [message()] }), activeGenerationIds: [] });
		expect(ended.requestedGeneration).toBeNull();
	});

	test("a Requested Swipe shows an empty Variant in place of the Requested selection until a page places its Variant", () => {
		const twoTakes = reduceStory(opened(), { type: "window-received", page: page({ messages: [message({ variants: [
			{ id: 100, position: 1, content: "Once", empty: false, hasReasoning: false, timestamp: "2026-01-01T00:00:00.000Z", selected: true },
			{ id: 101, position: 2, content: "Twice", empty: false, hasReasoning: false, timestamp: "2026-01-01T00:00:00.000Z", selected: false },
		] })] }) });
		const selected = reduceStory(twoTakes, { type: "selection-requested", messageId: 10, variantId: 101 });
		const requested = reduceStory(selected, { type: "generation-requested", request: { kind: "sibling", messageId: 10 } });
		const shown = shownMessage(requested, requested.messages[0]!);
		expect(shown.swipes).toHaveLength(3);
		expect(shown.swipes.at(-1)).toMatchObject({ id: displayedVariantId(shown, null, requested.requestedSelections), content: "", empty: true, hasReasoning: false });
		const accepted = reduceStory(requested, { type: "generation-request-accepted", generationId: 9, variantId: 102, sentRevision: 3 });
		const placed = reduceStory(accepted, { type: "window-received", page: page({ revision: 4, messages: [message({ variants: [
			{ id: 100, position: 1, content: "Once", empty: false, hasReasoning: false, timestamp: "2026-01-01T00:00:00.000Z", selected: false },
			{ id: 101, position: 2, content: "Twice", empty: false, hasReasoning: false, timestamp: "2026-01-01T00:00:00.000Z", selected: false },
			{ id: 102, position: 3, content: "", empty: true, hasReasoning: false, timestamp: "2026-01-01T00:00:01.000Z", selected: true },
		] })] }) });
		expect(shownMessage(placed, placed.messages[0]!).swipes.map(({ id }) => id)).toEqual([100, 101, 102]);
	});

	test("disappears when the server does not accept it", () => {
		const requested = reduceStory(opened(), { type: "generation-requested", request: { kind: "continuation" } });
		expect(reduceStory(requested, { type: "generation-request-failed" }).requestedGeneration).toBeNull();
	});

	test("Requested Moves show until their command settles, and an earlier settle keeps a later request", () => {
		const text = (body: string) => ({ to: "Mara", text: body });
		const state = reduceStory(opened(), { type: "window-received", page: page({ messages: [message({ moves: { phone: [text("A"), text("B"), text("C")] } })] }) });
		const first = reduceStory(state, { type: "moves-requested", messageId: 10, moves: { phone: [text("B"), text("C")] } });
		const second = reduceStory(first, { type: "moves-requested", messageId: 10, moves: { phone: [text("C")] } });
		expect(shownMessage(second, second.messages[0]!).moves).toEqual({ phone: [text("C")] });
		const firstApplied = reduceStory(second, { type: "moves-set", messageId: 10, moves: { phone: [text("B"), text("C")] } });
		expect(shownMessage(firstApplied, firstApplied.messages[0]!).moves).toEqual({ phone: [text("C")] });
		const secondApplied = reduceStory(firstApplied, { type: "moves-set", messageId: 10, moves: { phone: [text("C")] } });
		expect(secondApplied.requestedMoves.size).toBe(0);
		expect(secondApplied.messages[0]!.moves).toEqual({ phone: [text("C")] });
		const dropped = reduceStory(first, { type: "moves-dropped", messageId: 10 });
		expect(shownMessage(dropped, dropped.messages[0]!).moves).toEqual({ phone: [text("A"), text("B"), text("C")] });
	});

	test("reuses the trailing human Message only when it repeats that Message's text and Moves", () => {
		const state = opened();
		const texted = { phone: [{ to: "Mara", text: "Running late" }] };
		expect(reusesTrailingHumanMessage(state, 1, "Once", undefined)).toBe(true);
		expect(reusesTrailingHumanMessage(state, 1, "Once more", undefined)).toBe(false);
		expect(reusesTrailingHumanMessage(state, 2, "Once", undefined)).toBe(false);
		expect(reusesTrailingHumanMessage(state, 1, "Once", texted)).toBe(false);
		const textedState = reduceStory(state, { type: "window-received", page: page({ messages: [message({ moves: texted })] }) });
		expect(reusesTrailingHumanMessage(textedState, 1, "Once", texted)).toBe(true);
	});
});
