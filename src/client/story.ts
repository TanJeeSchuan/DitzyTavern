// @approved
//  Pure state transitions for reading a Chat's native history. The view
// feeds typed history pages and command outcomes into this reducer, so page
// accumulation, selected-Variant updates, and empty-Variant placeholders are
// testable without a browser or a frontend framework.
// Imported Chats use exactly this model: their Messages came through the
// same paginated read seam and their Swipe navigation is the same
// revisioned Variant-selection behavior as every other Chat. Empty and
// duplicate Variants stay separate navigable positions; an exact empty
// Variant renders a presentation-only placeholder and its stored text is
// never modified.

import type { ChatHistoryMessage, ChatHistoryPage, ChatHistoryVariant } from "./chat-history";

// @approved
//  A reading view of one Variant: the stored content plus whether the
// presentation should show the exact-empty placeholder instead.
export interface StoryVariant {
	id: number;
	position: number;
	content: string;
	// @approved
	//  Reasoning Content stays separate from authored Content. Active streams
	// update it locally and authoritative history restores it after reload.
	reasoning?: string;
	generationId?: number;
	lastEventId?: number;
	// @approved
	//  Presentation-only: true when the stored content is exactly empty. The
	// placeholder substitutes rendering only; the stored text stays as-is.
	empty: boolean;
}

export interface StoryMessage {
	id: number;
	position: number;
	timestamp: string;
	// @approved
	//  Immutable Author Stamp name (the captured resolved Participant name).
	authorName: string | null;
	authorParticipantId: number | null;
	// @approved
	//  Historical model Control identity, when the Message came from
	// generation. It may differ from the current Conversation Control.
	modelParticipantIdAtCreation: number | null;
	// @approved
	//  Server-derived capability for the selected Variant.
	continuable: boolean;
	// @approved
	//  Server-derived targeted Swipe eligibility carried by history (ADR-0003):
	// the canonical historical-pair rule decides, never client authorship
	// reconstruction.
	swipe: ChatHistoryMessage["swipe"];
	// @approved
	//  Whether the authoring Participant is still an active Cast member.
	inCast: boolean;
	// @approved
	//  Index of the persisted selected Variant within `swipes`.
	activeSwipe: number;
	swipes: StoryVariant[];
}

export interface StoryPreviewState {
	messageId: number;
	targetPosition: number;
	variantId: number;
	priorVariantId: number | null;
}

export interface PreviewSelectionRequest {
	conversationId: number;
	messageId: number;
	variantId: number;
}

export interface StoryPaging {
	index: number;
	pageSize: number;
	totalMessages: number;
	totalPages: number;
	hasOlder: boolean;
	hasNewer: boolean;
}

export interface StoryState {
	conversationId: number | null;
	title: string;
	// @approved
	//  Authoritative Conversation revision as of the last read page; the
	// revisioned command seam needs it when the full snapshot is not loaded.
	revision: number | null;
	// @approved
	//  Accumulated stable chronological Messages, deduplicated by Message id.
	// One contiguous page window: older pages prepend and newer pages append.
	messages: StoryMessage[];
	page: StoryPaging | null;
	status: "idle" | "loading-first" | "loading-more" | "ready" | "error";
	preview: StoryPreviewState | null;
	// @approved
	//  Stream observations for a Variant no page has placed yet. A page can land after the events for the
	// Message it introduces, or after a jump to the latest Messages; they replay once their Variant arrives with
	// the same live Generation. Snapshots replace covered events; authoritative refreshes retire ended Generations.
	unplacedObservations: readonly GenerationObservation[];
}

type GenerationObservation = Extract<StoryAction, { type: "generation-observed" }>;

export type StoryAction =
	// @approved
	//  A different Chat is being opened (or the current one re-requested);
	// the reader resets and loads the first page fresh.
	| { type: "chat-opened"; conversationId: number }
	| { type: "window-received"; page: ChatHistoryPage; activeGenerationIds?: readonly number[] }
	// @approved
	//  The view requested an adjacent page; further requests are ignored until
	// it arrives or fails.
	| { type: "load-more-started" }
	| { type: "paging-cancelled" }
	| { type: "history-failed" }
	// @approved
	//  An optimistic selected-Variant update following the revisioned
	// select-variant command; the server response is authoritative but the
	// local position updates immediately so reading never waits.
	| { type: "swipe-selected"; messageId: number; variantId: number }
	// @approved
	//  One observation of an Active Generation's stream for the Provisional
	// Variant. An authoritative snapshot replaces both accumulated fields
	// atomically — the wire snapshot carries content and reasoning together
	// under one event id — and a streaming delta appends to the stream it
	// belongs to. The Generation session machine is the only producer.
	| {
			type: "generation-observed";
			messageId: number;
			variantId: number;
			mode: "replace";
			content: string;
			reasoning: string;
			generationId: number;
			eventId: number;
		}
	| {
			type: "generation-observed";
			messageId: number;
			variantId: number;
			stream: "content" | "reasoning";
			mode: "append";
			text: string;
			generationId: number;
			eventId: number;
		}
	| { type: "preview-started"; messageId: number; variantId: number }
	// @approved
	//  Swiping the already-previewed Message moves the local Preview to another
	// Variant of the same Message without any server command.
	| { type: "preview-retargeted"; messageId: number; variantId: number }
	| { type: "preview-cancelled" }
	| { type: "preview-confirmed" };

export const createStoryState = (): StoryState => ({
	conversationId: null,
	title: "",
	revision: null,
	messages: [],
	page: null,
	status: "idle",
	preview: null,
	unplacedObservations: [],
});

// @approved
//  An exact empty Variant is presented with a placeholder; whitespace-only
// content is not empty and renders as stored.
const toStoryVariant = (
	variant: ChatHistoryVariant,
	prior?: StoryVariant,
	activeGenerationIds: ReadonlySet<number> = new Set(),
): StoryVariant => {
	const live = variant.liveGeneration;
	if (
		prior?.generationId !== undefined &&
		activeGenerationIds.has(prior.generationId) &&
		(live === undefined || (prior.lastEventId ?? 0) > live.eventId)
	) {
		return { ...prior, id: variant.id, position: variant.position };
	}
	const content = live?.content ?? variant.content;
	return {
		id: variant.id,
		position: variant.position,
		content,
		reasoning: live?.reasoning ?? variant.reasoning ?? prior?.reasoning ?? "",
		generationId: live?.generationId ?? prior?.generationId,
		lastEventId: live?.eventId ?? prior?.lastEventId,
		empty: content === "",
	};
};

const toStoryMessage = (
	message: ChatHistoryPage["messages"][number],
	prior?: StoryMessage,
	activeGenerationIds?: ReadonlySet<number>,
): StoryMessage => ({
	id: message.id,
	position: message.position,
	timestamp: message.timestamp,
	authorName: message.author?.capturedName ?? null,
	authorParticipantId: message.author?.participantId ?? null,
	modelParticipantIdAtCreation: message.modelParticipantIdAtCreation,
	continuable: message.continuable,
	swipe: message.swipe,
	inCast: message.author?.inCast ?? false,
	activeSwipe: Math.max(
		0,
		message.variants.findIndex((variant) => variant.selected),
	),
	swipes: message.variants.map((variant) => toStoryVariant(
		variant,
		prior?.swipes.find((entry) => entry.id === variant.id),
		activeGenerationIds,
	)),
});

// @approved
//  A generated Message remains continuable when the current model Control has
// moved to another Participant: the generation-time model identity is the
// one authorship signal the client reads for Continue. Intentional per Fix 8
// scope: sibling eligibility is fully server-derived (swipe), while Continue
// still combines the server capability `continuable` with this generation-time
// authorship identity; deriving Continue eligibility fully server-side is a
// separate product decision, not a Fix 8 gap.
export const isModelAuthoredMessage = (
	message: Pick<StoryMessage, "authorParticipantId" | "modelParticipantIdAtCreation">,
): boolean =>
	message.modelParticipantIdAtCreation !== null &&
	message.authorParticipantId === message.modelParticipantIdAtCreation;

// @approved
//  New Swipe follows the server-derived eligibility carried by history: the
// server owns the rule (playability and the captured historical Control
// pair, ADR-0003), so the client never reconstructs it. The live summary's
// playability still gates on the fresher read. When sibling attempts are
// already active, the server permits parallel work only at that same
// response position, so the client hides conflicting targets while leaving
// the active target available for another parallel attempt.
export const canOfferSiblingGeneration = ({
	message,
	playable,
	previewActive,
	activeGenerationMessageIds,
}: {
	message: Pick<StoryMessage, "id" | "swipe">;
	playable: boolean;
	previewActive: boolean;
	activeGenerationMessageIds: readonly number[];
}): boolean =>
	playable &&
	message.swipe.eligible &&
	!previewActive &&
	activeGenerationMessageIds.every((messageId) => messageId === message.id);

const updateStoryVariant = (
	state: StoryState,
	messageId: number,
	variantId: number,
	update: (variant: StoryVariant) => StoryVariant,
): StoryState => ({
	...state,
	messages: state.messages.map((message) =>
		message.id !== messageId
			? message
			: {
					...message,
					swipes: message.swipes.map((variant) =>
						variant.id !== variantId ? variant : update(variant),
					),
				},
	),
});

const acceptsGenerationObservation = (
	variant: StoryVariant,
	generationId: number | undefined,
	eventId: number | undefined,
): boolean =>
	(generationId === undefined ||
		variant.generationId === undefined ||
		variant.generationId === generationId) &&
	(eventId === undefined || eventId > (variant.lastEventId ?? 0));

const findVariant = (state: StoryState, { messageId, variantId }: GenerationObservation) =>
	state.messages.find((message) => message.id === messageId)?.swipes.find((variant) => variant.id === variantId);

export function reduceStory(state: StoryState, action: StoryAction): StoryState {
	if (action.type === "generation-observed" && findVariant(state, action) === undefined) {
		const held = action.mode === "replace"
			? state.unplacedObservations.filter((observation) => observation.generationId !== action.generationId || observation.eventId > action.eventId)
			: state.unplacedObservations;
		return { ...state, unplacedObservations: action.mode === "replace" ? [action, ...held] : [...held, action] };
	}
	const next = reduceStoryAction(state, action);
	if (next.messages === state.messages || next.unplacedObservations.length === 0) return next;
	const placed = next.unplacedObservations.filter((observation) => findVariant(next, observation) !== undefined);
	if (placed.length === 0) return next;
	const replayable = placed.filter((observation) => findVariant(next, observation)?.generationId === observation.generationId);
	const unplacedObservations = next.unplacedObservations.filter((observation) => !placed.includes(observation));
	return replayable.reduce(reduceStoryAction, { ...next, unplacedObservations });
}

function reduceStoryAction(state: StoryState, action: StoryAction): StoryState {
	switch (action.type) {
		case "chat-opened":
			return {
				...createStoryState(),
				conversationId: action.conversationId,
				status: "loading-first",
			};
		case "window-received":
			if (state.conversationId !== action.page.conversationId || action.page.revision < (state.revision ?? 0)) return state;
			const activeGenerationIds = new Set(action.activeGenerationIds ?? []);
			const previewed = action.page.messages.find((message) => message.id === state.preview?.messageId);
			const selectedId = previewed?.variants.find((variant) => variant.selected)?.id ?? null;
			const preview = state.preview !== null && selectedId !== state.preview.variantId && previewed?.variants.some((variant) => variant.id === state.preview?.variantId)
				? { ...state.preview, priorVariantId: selectedId }
				: null;
			return {
				...state,
				title: action.page.name,
				revision: action.page.revision,
				messages: action.page.messages.map((message) => toStoryMessage(
					message,
					state.messages.find((entry) => entry.id === message.id),
					activeGenerationIds,
				)),
				page: action.page.page,
				status: "ready",
				preview,
				unplacedObservations: state.unplacedObservations.filter(({ generationId }) => action.activeGenerationIds === undefined || activeGenerationIds.has(generationId)),
			};
		case "load-more-started":
			return (state.status === "ready" || state.status === "error") && (state.page?.hasOlder === true || state.page?.hasNewer === true)
				? { ...state, status: "loading-more" }
				: state;
		case "paging-cancelled":
			return state.status === "loading-more" ? { ...state, status: "ready" } : state;
		case "history-failed":
			return { ...state, status: "error" };
		case "swipe-selected":
			if (state.preview !== null) return state;
			return {
				...state,
				messages: state.messages.map((message) => {
					if (message.id !== action.messageId) return message;
					const index = message.swipes.findIndex(
						(variant) => variant.id === action.variantId,
					);
					if (index === -1) return message;
					return { ...message, activeSwipe: index };
				}),
			};
		case "generation-observed":
			return updateStoryVariant(state, action.messageId, action.variantId, (variant) => {
				if (!acceptsGenerationObservation(variant, action.generationId, action.eventId)) return variant;
				if (action.mode === "replace") {
					return {
						...variant,
						content: action.content,
						reasoning: action.reasoning,
						empty: action.content === "",
						generationId: action.generationId,
						lastEventId: action.eventId,
					};
				}
				if (action.stream === "content") {
					const content = variant.content + action.text;
					return {
						...variant,
						content,
						empty: content === "",
						generationId: action.generationId,
						lastEventId: action.eventId,
					};
				}
				return {
					...variant,
					reasoning: (variant.reasoning ?? "") + action.text,
					generationId: action.generationId,
					lastEventId: action.eventId,
				};
			});
		case "preview-started": {
			if (state.preview !== null) return state;
			const message = state.messages.find((entry) => entry.id === action.messageId);
			if (message === undefined) return state;
			const previewVariant = message.swipes.find(
				(variant) => variant.id === action.variantId,
			);
			if (previewVariant === undefined) return state;
			if (message.swipes[message.activeSwipe]?.id === previewVariant.id) return state;
			return {
				...state,
				preview: {
					messageId: message.id,
					targetPosition: message.position,
					variantId: previewVariant.id,
					priorVariantId: message.swipes[message.activeSwipe]?.id ?? null,
				},
			};
		}
		case "preview-retargeted": {
			if (state.preview === null) return state;
			if (state.preview.messageId !== action.messageId) return state;
			const message = state.messages.find((entry) => entry.id === action.messageId);
			if (message === undefined) return state;
			const variant = message.swipes.find(
				(entry) => entry.id === action.variantId,
			);
			if (variant === undefined) return state;
			if (variant.id === state.preview.variantId) return state;
			// @approved
			//  Cycling back to the server-selected Variant ends the local Preview:
			// there is no longer a divergent selection to confirm or cancel.
			if (variant.id === state.preview.priorVariantId) {
				return { ...state, preview: null };
			}
			return {
				...state,
				preview: { ...state.preview, variantId: variant.id },
			};
		}
		case "preview-cancelled":
			return state.preview === null ? state : { ...state, preview: null };
		case "preview-confirmed": {
			if (state.preview === null) return state;
			const preview = state.preview;
			const message = state.messages.find((entry) => entry.id === preview.messageId);
			const activeSwipe = message?.swipes.findIndex(
				(variant) => variant.id === preview.variantId,
			);
			if (message === undefined || activeSwipe === undefined || activeSwipe < 0) {
				return state;
			}
			return {
				...state,
				preview: null,
				messages: state.messages.map((entry) =>
					entry.id === message.id ? { ...entry, activeSwipe } : entry,
				),
			};
		}
	}
}

// @approved
//  The placeholder shown for an exact empty Variant. Presentation-only: the
// stored content is never rewritten to contain it.
export const EMPTY_VARIANT_PLACEHOLDER = "(empty alternative)";

// @approved
//  The content to render for one Variant: the stored text, or the
// presentation-only placeholder for exact empty content.
export const visibleVariantContent = (variant: StoryVariant): string =>
	variant.empty ? EMPTY_VARIANT_PLACEHOLDER : variant.content;

export type StoryVariantSelection =
	| { kind: "noop" }
	| { kind: "blocked" }
	| { kind: "immediate"; messageId: number; variantId: number }
	| { kind: "preview"; messageId: number; variantId: number };

// @approved
//  A Swipe previews when later Messages exist, including outside the window.
// The final Message can switch immediately because there is nothing to dim.
export const classifyVariantSelection = (
	state: StoryState,
	messageId: number,
	variantId: number,
): StoryVariantSelection => {
	if (state.preview !== null) return { kind: "blocked" };
	const message = state.messages.find((entry) => entry.id === messageId);
	if (message === undefined) return { kind: "blocked" };
	const target = message.swipes.find((variant) => variant.id === variantId);
	if (target === undefined) return { kind: "blocked" };
	if (message.swipes[message.activeSwipe]?.id === target.id) return { kind: "noop" };
	return state.page?.hasNewer || state.messages.some((later) => later.position > message.position)
		? { kind: "preview", messageId, variantId }
		: { kind: "immediate", messageId, variantId };
};

// @approved
//  The visible Variant is local-only while Preview mode is active. The stored
// selected Variant remains untouched until the ordinary command is confirmed.
export const displayedVariantId = (
	message: StoryMessage,
	preview: StoryPreviewState | null,
): number | null => {
	if (preview?.messageId === message.id) return preview.variantId;
	return message.swipes[message.activeSwipe]?.id ?? null;
};

export const isPreviewDownstream = (
	message: StoryMessage,
	preview: StoryPreviewState | null,
): boolean =>
	preview !== null && message.position > preview.targetPosition;

// @approved
//  Navigation is the one client action that may discard a local Preview. The
// caller owns the confirmation dialog and passes numeric Conversation ids;
// this pure predicate keeps that policy testable without a browser and
// avoids warning when the selected Chat did not actually change.
export const previewNavigationNeedsConfirmation = (
	preview: StoryPreviewState | null,
	currentConversationId: number | null,
	nextConversationId: number,
): boolean =>
	preview !== null && currentConversationId !== nextConversationId;

export type PreviewConfirmationResult<Result> =
	| { status: "not-sent" }
	| { status: "sent"; result: Result };

// @approved
//  A transport boundary for confirmation: no request is sent without the
// matching client preview. The revision guard and outcome reconciliation
// live in the Conversation command runner the caller composes into `send`;
// the concrete Conversation transport stays outside the pure story reducer.
export async function confirmPreviewSelection<Result>(
	preview: StoryPreviewState | null,
	request: PreviewSelectionRequest,
	send: (request: PreviewSelectionRequest) => Promise<Result>,
): Promise<PreviewConfirmationResult<Result>> {
	if (
		preview === null ||
		preview.messageId !== request.messageId ||
		preview.variantId !== request.variantId
	) {
		return { status: "not-sent" };
	}
	return { status: "sent", result: await send(request) };
}
