import { describe, expect, test } from "bun:test";
import type { ChatHistoryPage } from "./chat-history";
import {
	EMPTY_VARIANT_PLACEHOLDER,
	canOfferSiblingGeneration,
	classifyVariantSelection,
	confirmPreviewSelection,
	createStoryState,
	displayedVariantId,
	isPreviewDownstream,
	previewNavigationNeedsConfirmation,
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
	overrides: Partial<Omit<
		ChatHistoryPage["messages"][number],
		"modelParticipantIdAtCreation" | "continuable" | "swipe"
	>> = {},
): ChatHistoryPage["messages"][number] => ({
	id: 10,
	position: 1,
	timestamp: "2026-01-01T00:00:00.000Z",
	modelParticipantIdAtCreation: null,
	continuable: true,
	swipe: { eligible: true, reason: null },
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
	modelParticipantIdAtCreation: null,
	continuable: true,
	// Server-derived capability carried by history: eligible unless a test
	// overrides it with the server's typed ineligibility.
	swipe: { eligible: true, reason: null },
	inCast: true,
	activeSwipe: 0,
	swipes: [
		{ id: id * 10, position: 1, content: `Selected ${id}`, empty: false },
		{ id: id * 10 + 1, position: 2, content: `Alternative ${id}`, empty: false },
	],
});

describe("story reading state", () => {
	test("offers New Swipe on a server-eligible Message and honors the active response position", () => {
		const olderEligible: StoryMessage = storyMessage(10, 1, 20);
		const newerEligible: StoryMessage = storyMessage(11, 2, 20);
		const messages = [olderEligible, newerEligible];

		expect(messages.at(-1)?.id).toBe(newerEligible.id);
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
		expect(switched.conversationId).toBe(8);
		expect(switched.messages).toEqual([]);
		expect(switched.status).toBe("loading-first");
	});

	test("a model Message with later Messages enters Preview", () => {
		const messages = [
			storyMessage(120, 1, 20),
			storyMessage(122, 2, 20),
			storyMessage(123, 3, 10),
			storyMessage(125, 4, 10),
		];
		const state = { ...createStoryState(), messages };

		expect(classifyVariantSelection(state, 122, 1221)).toEqual({
			kind: "preview",
			messageId: 122,
			variantId: 1221,
		});
	});

	test("older Variant selection enters one local Preview with downstream read-only state", () => {
		const state: StoryStateForPreview = {
			...createStoryState(),
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
		const attemptedSelection = reduceStory(previewing, {
			type: "swipe-selected",
			messageId: 1,
			variantId: 10,
		});
		expect(attemptedSelection.messages[0]?.activeSwipe).toBe(0);
	});

	test("the previewed Message's Variants can be switched freely while Preview stays local", () => {
		const target: StoryMessage = {
			...storyMessage(1, 1, 10),
			swipes: [
				{ id: 10, position: 1, content: "Selected", empty: false },
				{ id: 11, position: 2, content: "Second", empty: false },
				{ id: 12, position: 3, content: "Third", empty: false },
			],
		};
		const state: StoryStateForPreview = {
			...createStoryState(),
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
		}, 7, 8)).toBe(true);
	});

	test("cancelling Preview restores the authoritative path without a command", () => {
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
		const cancelled = reduceStory(previewing, { type: "preview-cancelled" });
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
			type: "window-received",
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
		};
		const requests: number[] = [];
		const request = {
			conversationId: 7,
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

describe("streaming Provisional Variant content", () => {
	const stateWithProvisional = () => {
		let state = reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 });
		state = reduceStory(state, {
			type: "window-received",
			page: page({
				revision: 4,
				messages: [message({
					id: 10,
					variants: [
						{ id: 100, position: 1, content: "", timestamp: "2026-01-01T00:00:00.000Z", selected: true },
					],
				})],
			}),
		});
		return state;
	};

	const variantContent = (state: ReturnType<typeof createStoryState>, variantId: number) =>
		state.messages[0]?.swipes.find((variant) => variant.id === variantId);

	test("Content deltas append to the Provisional Variant and update the empty placeholder", () => {
		let state = stateWithProvisional();
		state = reduceStory(state, { type: "generation-observed", stream: "content", mode: "append", messageId: 10, variantId: 100, text: "Once upon ", generationId: 55, eventId: 1 });
		state = reduceStory(state, { type: "generation-observed", stream: "content", mode: "append", messageId: 10, variantId: 100, text: "a time", generationId: 55, eventId: 2 });

		const variant = variantContent(state, 100);
		expect(variant?.content).toBe("Once upon a time");
		expect(variant?.empty).toBe(false);
	});

	test("an authoritative Content replace overwrites the accumulated text", () => {
		let state = stateWithProvisional();
		state = reduceStory(state, { type: "generation-observed", stream: "content", mode: "append", messageId: 10, variantId: 100, text: "Stale tail", generationId: 55, eventId: 1 });
		state = reduceStory(state, { type: "generation-observed", mode: "replace", messageId: 10, variantId: 100, content: "Authoritative", reasoning: "", generationId: 55, eventId: 2 });

		expect(variantContent(state, 100)?.content).toBe("Authoritative");
	});

	test("Reasoning Content streams separately and survives an authoritative history refresh", () => {
		let state = stateWithProvisional();
		state = reduceStory(state, {
			type: "generation-observed",
			stream: "reasoning",
			mode: "append",
			messageId: 10,
			variantId: 100,
			text: "First thought. ",
			generationId: 55,
			eventId: 1,
		});
		state = reduceStory(state, {
			type: "generation-observed",
			mode: "replace",
			messageId: 10,
			variantId: 100,
			reasoning: "Authoritative thought.",
			content: "Finished.",
			generationId: 55,
			eventId: 2,
		});

		expect(variantContent(state, 100)?.reasoning).toBe("Authoritative thought.");

		state = reduceStory(state, {
			type: "window-received",
			page: page({
				revision: 5,
				messages: [message({
					id: 10,
					variants: [
						{ id: 100, position: 1, content: "Finished.", timestamp: "2026-01-01T00:00:00.000Z", selected: true },
					],
				})],
			}),
		});

		expect(variantContent(state, 100)?.content).toBe("Finished.");
		expect(variantContent(state, 100)?.reasoning).toBe("Authoritative thought.");
	});

	test("stream events that land before the page placing their Variant replay once it arrives", () => {
		const observe = (eventId: number, text: string) => ({
			type: "generation-observed" as const, stream: "content" as const, mode: "append" as const,
			messageId: 11, variantId: 110, generationId: 55, eventId, text,
		});
		const provisional = (live: { eventId: number; content: string } | null, content = "") => {
			const variant: ChatHistoryPage["messages"][number]["variants"][number] = {
				id: 110, position: 1, content, timestamp: "2026-01-01T00:00:00.000Z", selected: true,
			};
			if (live) variant.liveGeneration = { generationId: 55, eventId: live.eventId, content: live.content, reasoning: "" };
			return page({ messages: [message({ id: 11, variants: [variant] })] });
		};
		const early = [observe(1, "The tide."), observe(2, " The lights."), observe(3, " Then the")]
			.reduce(reduceStory, reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 }));

		const live = reduceStory(early, { type: "window-received", page: provisional({ eventId: 0, content: "" }), activeGenerationIds: [55] });
		expect(variantContent(live, 110)?.content).toBe("The tide. The lights. Then the");

		const checkpointed = reduceStory(early, { type: "window-received", page: provisional({ eventId: 2, content: "The tide. The lights." }), activeGenerationIds: [55] });
		expect(variantContent(checkpointed, 110)?.content).toBe("The tide. The lights. Then the");

		const finished = reduceStory(early, { type: "window-received", page: provisional(null, "The tide. The lights. Then the end.") });
		expect(variantContent(finished, 110)?.content).toBe("The tide. The lights. Then the end.");
		expect(finished.unplacedObservations).toEqual([]);
	});

	test("held stream events survive a jump back to the latest Messages, and a snapshot supersedes earlier ones", () => {
		const observe = (eventId: number, text: string) => ({
			type: "generation-observed" as const, stream: "content" as const, mode: "append" as const,
			messageId: 11, variantId: 110, generationId: 55, eventId, text,
		});
		let state = reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 });
		state = reduceStory(state, { type: "window-received", page: page({ page: { index: 2, pageSize: 2, totalMessages: 4, totalPages: 2, hasOlder: false, hasNewer: true } }) });
		state = [observe(1, "One."), observe(2, " Two."), observe(3, " Three.")].reduce(reduceStory, state);
		const latest = page({
			messages: [message({
				id: 11,
				variants: [{
					id: 110, position: 1, content: "", timestamp: "2026-01-01T00:00:00.000Z", selected: true,
					liveGeneration: { generationId: 55, eventId: 1, content: "One.", reasoning: "" },
				}],
			})],
		});
		const returned = reduceStory(state, { type: "window-received", page: latest, activeGenerationIds: [55] });
		expect(variantContent(returned, 110)?.content).toBe("One. Two. Three.");

		const snapshot = reduceStory(state, {
			type: "generation-observed", mode: "replace", messageId: 11, variantId: 110, generationId: 55, eventId: 4, content: "One. Two. Three. Four.", reasoning: "",
		});
		expect(snapshot.unplacedObservations).toHaveLength(1);
		const staleSnapshot = reduceStory(state, {
			type: "generation-observed", mode: "replace", messageId: 11, variantId: 110, generationId: 55, eventId: 1, content: "One.", reasoning: "",
		});
		expect(variantContent(reduceStory(staleSnapshot, { type: "window-received", page: latest, activeGenerationIds: [55] }), 110)?.content).toBe("One. Two. Three.");
		const finished = reduceStory(state, { type: "window-received", page: page(), activeGenerationIds: [] });
		expect(finished.unplacedObservations).toEqual([]);
	});

	test("history checkpoint and replay resume share one ordered projection", () => {
		let state = reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 });
		state = reduceStory(state, {
			type: "window-received",
			page: page({
				messages: [message({
					id: 10,
					variants: [{
						id: 100,
						position: 1,
						content: "Saved",
						timestamp: "2026-01-01T00:00:00.000Z",
						selected: true,
						liveGeneration: {
							generationId: 55,
							eventId: 1,
							content: "Saved",
							reasoning: "",
						},
					}],
				})],
			}),
			activeGenerationIds: [55],
		});
		state = reduceStory(state, {
			type: "generation-observed",
			stream: "content",
			mode: "append",
			messageId: 10,
			variantId: 100,
			generationId: 55,
			eventId: 1,
			text: "Saved",
		});
		expect(variantContent(state, 100)?.content).toBe("Saved");

		state = reduceStory(state, {
			type: "generation-observed",
			stream: "content",
			mode: "append",
			messageId: 10,
			variantId: 100,
			generationId: 55,
			eventId: 2,
			text: " next",
		});
		expect(variantContent(state, 100)?.content).toBe("Saved next");
	});

	test("Reasoning Content reconstructs from authoritative history without prior client state", () => {
		let state = createStoryState();
		state = reduceStory(state, { type: "chat-opened", conversationId: 42 });
		state = reduceStory(state, {
			type: "window-received",
			page: page({
				conversationId: 42,
				revision: 5,
				messages: [message({
					id: 10,
					variants: [{
						id: 100,
						position: 1,
						content: "Finished.",
						reasoning: "Persisted thought.",
						timestamp: "2026-01-01T00:00:00.000Z",
						selected: true,
					}],
				})],
			}),
		});

		expect(variantContent(state, 100)?.reasoning).toBe("Persisted thought.");
	});

	test("deltas ignore Variants and Messages that are not in the current read model", () => {
		const state = stateWithProvisional();
		const untouched = reduceStory(state, { type: "generation-observed", stream: "content", mode: "append", messageId: 999, variantId: 100, text: "x", generationId: 55, eventId: 1 });
		const unknownVariant = reduceStory(state, { type: "generation-observed", stream: "content", mode: "append", messageId: 10, variantId: 999, text: "x", generationId: 55, eventId: 1 });

		expect(variantContent(untouched, 100)?.content).toBe("");
		expect(variantContent(unknownVariant, 100)?.content).toBe("");
	});
});

type StoryStateForPreview = ReturnType<typeof createStoryState> & {
	messages: StoryMessage[];
};


describe("detached story windows", () => {
	const history = (index: number, positions: number[], totalMessages = 8) => page({
		page: { index, pageSize: 2, totalMessages, totalPages: Math.ceil(totalMessages / 2), hasOlder: index < Math.ceil(totalMessages / 2), hasNewer: index > 1 },
		messages: positions.map((position) => message({ id: position, position, variants: [
			{ id: position * 10, position: 1, content: `Message ${position}`, timestamp: "", selected: true },
			{ id: position * 10 + 1, position: 2, content: "Alternative", timestamp: "", selected: false },
		] })),
	});
	const open = () => reduceStory(reduceStory(createStoryState(), { type: "chat-opened", conversationId: 7 }), { type: "window-received", page: history(1, [7, 8]) });
	const detach = () => reduceStory(open(), { type: "window-received", page: history(3, [3, 4]) });

	test("a source jump replaces the latest window with one page", () => {
		const state = detach();
		expect(state.messages.map(({ id }) => id)).toEqual([3, 4]);
		expect(state.page).toMatchObject({ index: 3, hasNewer: true, hasOlder: true });
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
		selectedElsewhere.messages[0]!.variants.push({ id: 32, position: 3, content: "Third", timestamp: "", selected: true });
		expect(reduceStory(refreshed, { type: "window-received", page: selectedElsewhere }).preview?.priorVariantId).toBe(32);
		selectedElsewhere.messages[0]!.variants[2]!.selected = false;
		selectedElsewhere.messages[0]!.variants[1]!.selected = true;
		expect(reduceStory(refreshed, { type: "window-received", page: selectedElsewhere }).preview).toBeNull();
	});

	test("live observations outside the window never insert Messages and visible observations still apply", () => {
		const state = detach();
		const outside = reduceStory(state, { type: "generation-observed", mode: "replace", messageId: 8, variantId: 80, generationId: 1, eventId: 1, content: "Outside", reasoning: "" });
		expect(outside.messages).toEqual(state.messages);
		const inside = reduceStory(outside, { type: "generation-observed", mode: "append", stream: "content", messageId: 4, variantId: 40, generationId: 2, eventId: 1, text: " continues" });
		expect(inside.messages.at(-1)?.swipes[0]?.content).toBe("Message 4 continues");
		expect(inside.messages).toHaveLength(2);
	});

	test("authoritative refreshes update only loaded Messages and preserve a newer live checkpoint", () => {
		const state = reduceStory(detach(), { type: "generation-observed", mode: "append", stream: "content", messageId: 4, variantId: 40, generationId: 2, eventId: 2, text: " streaming" });
		const refreshed = reduceStory(state, { type: "window-received", page: history(2, [3, 4], 7), activeGenerationIds: [2] });
		expect(refreshed.messages.map(({ id }) => id)).toEqual([3, 4]);
		expect(refreshed.messages.at(-1)?.swipes[0]?.content).toBe("Message 4 streaming");
		const final = history(2, [3, 4], 7);
		final.messages[1]!.variants[0]!.content = "Finished";
		const settled = reduceStory(refreshed, { type: "window-received", page: final });
		expect(settled.messages.at(-1)?.swipes[0]?.content).toBe("Finished");
		expect(settled.page?.hasNewer).toBe(true);
	});

	test("a detached final visible Message needs Swipe preview", () => {
		expect(classifyVariantSelection(detach(), 4, 41).kind).toBe("preview");
		expect(classifyVariantSelection(open(), 8, 81).kind).toBe("immediate");
	});
});
