import type { ChatHistoryMessage, ChatHistoryPage, ChatHistoryVariant } from "./chat-history";
import { sameMoves, type BoxMoves } from "../shared/contract/box-generation";

// @approved
//  A reading view of one Variant: the stored content plus whether the
// presentation should show the exact-empty placeholder instead.
export interface StoryVariant {
	id: number;
	position: number;
	// @approved
	//  Null until the story needs a Variant the page did not carry: another
	// Variant than the selected one loads through the Variant text read.
	content: string | null;
	// @approved
	//  Reasoning Content stays separate from authored Content. A page carries a
	// live Generation's; persisted Reasoning Content, which `hasReasoning`
	// announces, loads through the Variant text read when it is opened.
	reasoning?: string;
	hasReasoning: boolean;
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
	authorRole: ChatHistoryMessage["authorRole"];
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
	moves: ChatHistoryMessage["moves"];
	swipes: StoryVariant[];
}

type Preview = { messageId: number; variantId: number };
type StoryPreviewState = Preview & { targetPosition: number };

export type RequestedWrite<Value> = { value: Value };

type WriteOverlay<Value> = {
	pending: RequestedWrite<Value> | undefined;
	accepted: { value: Value; revision: number } | undefined;
};

export type RequestedGeneration =
	| { kind: "send"; content: string; moves?: BoxMoves | undefined }
	| { kind: "continuation" }
	| { kind: "sibling"; messageId: number };

export type StoryOverlays = {
	preview: Preview | null;
	requestedSelections: ReadonlyMap<number, WriteOverlay<number>>;
	requestedMoves: ReadonlyMap<number, WriteOverlay<BoxMoves>>;
	requestedGeneration: {
		request: RequestedGeneration;
		accepted: { generationId: number; variantId: number; sentRevision: number } | null;
	} | null;
};

export type StoryWindow = {
	revision: number;
	page: ChatHistoryPage["page"];
	messages: readonly StoryMessage[];
};

export type StoryState = Omit<StoryOverlays, "preview"> & {
	preview: StoryPreviewState | null;
	messages: readonly StoryMessage[];
} & (
	| { status: "idle" }
	| { status: "loading-first" | "error"; conversationId: number }
	| { status: "ready"; loadingMore: boolean; historyFailed: boolean; conversationId: number; revision: number; page: StoryWindow["page"] }
);

export const isStoryReady = (state: StoryState): state is Extract<StoryState, { status: "ready" }> =>
	state.status === "ready";

export type StoryAction =
	| { type: "preview-changed"; preview: Preview | null }
	| { type: "preview-confirmed"; messageId: number; request: RequestedWrite<number> }
	| { type: "selection-requested"; messageId: number; request: RequestedWrite<number> }
	| { type: "selection-settled"; messageId: number; request: RequestedWrite<number>; revision: number | null }
	| { type: "moves-requested"; messageId: number; request: RequestedWrite<BoxMoves> }
	| { type: "moves-settled"; messageId: number; request: RequestedWrite<BoxMoves>; revision: number | null }
	| { type: "generation-requested"; request: RequestedGeneration }
	| { type: "generation-request-accepted"; generationId: number; variantId: number; sentRevision: number }
	| { type: "generation-request-failed" };

export const createStoryOverlays = (): StoryOverlays => ({
	preview: null,
	requestedSelections: new Map(),
	requestedMoves: new Map(),
	requestedGeneration: null,
});

// @approved
//  An exact empty Variant is presented with a placeholder; whitespace-only
// content is not empty and renders as stored. The page is the authority: text
// it leaves out is read again rather than kept from an earlier page, which
// another tab's edit may have outdated. A live Generation's newer streamed
// text stays with the Message showing it (story/variant-streams).
const toStoryVariant = (variant: ChatHistoryVariant): StoryVariant => {
	const live = variant.liveGeneration;
	const reasoning = live?.reasoning ?? "";
	return {
		id: variant.id,
		position: variant.position,
		content: live?.content ?? variant.content ?? null,
		reasoning,
		hasReasoning: variant.hasReasoning || reasoning !== "",
		generationId: live?.generationId,
		lastEventId: live?.eventId,
		empty: live === undefined ? variant.empty : live.content === "",
	};
};

export const toStoryMessage = (message: ChatHistoryMessage): StoryMessage => ({
	id: message.id,
	position: message.position,
	timestamp: message.timestamp,
	authorName: message.author?.capturedName ?? null,
	authorParticipantId: message.author?.participantId ?? null,
	authorRole: message.authorRole,
	modelParticipantIdAtCreation: message.modelParticipantIdAtCreation,
	continuable: message.continuable,
	swipe: message.swipe,
	inCast: message.author?.inCast ?? false,
	activeSwipe: Math.max(
		0,
		message.variants.findIndex((variant) => variant.selected),
	),
	swipes: message.variants.map(toStoryVariant),
	moves: message.moves,
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

export function reduceStoryOverlays(state: StoryOverlays, action: StoryAction): StoryOverlays {
	switch (action.type) {
		case "preview-changed":
			return { ...state, preview: action.preview };
		case "preview-confirmed":
		case "selection-requested":
			return {
				...state,
				preview: action.type === "preview-confirmed" ? null : state.preview,
				requestedSelections: requestWrite(state.requestedSelections, action.messageId, action.request),
			};
		case "selection-settled":
			return { ...state, requestedSelections: settleWrite(state.requestedSelections, action) };
		case "moves-requested":
			return { ...state, requestedMoves: requestWrite(state.requestedMoves, action.messageId, action.request) };
		case "moves-settled":
			return { ...state, requestedMoves: settleWrite(state.requestedMoves, action) };
		case "generation-requested":
			return {
				...state,
				requestedGeneration: { request: action.request, accepted: null },
				requestedSelections: action.request.kind === "sibling" ? requestWrite(state.requestedSelections, action.request.messageId, undefined) : state.requestedSelections,
			};
		case "generation-request-accepted":
			return state.requestedGeneration === null
				? state
				: { ...state, requestedGeneration: { ...state.requestedGeneration, accepted: { generationId: action.generationId, variantId: action.variantId, sentRevision: action.sentRevision } } };
		case "generation-request-failed":
			return { ...state, requestedGeneration: null };
	}
}

function setWrite<Value>(writes: ReadonlyMap<number, WriteOverlay<Value>>, messageId: number, overlay: WriteOverlay<Value>) {
	const previous = writes.get(messageId);
	if (previous?.pending === overlay.pending && previous?.accepted === overlay.accepted) return writes;
	if (overlay.pending === undefined && overlay.accepted === undefined) return without(writes, messageId);
	return new Map(writes).set(messageId, overlay);
}

function requestWrite<Value>(writes: ReadonlyMap<number, WriteOverlay<Value>>, messageId: number, pending: RequestedWrite<Value> | undefined) {
	return setWrite(writes, messageId, { pending, accepted: writes.get(messageId)?.accepted });
}

function settleWrite<Value>(
	writes: ReadonlyMap<number, WriteOverlay<Value>>,
	{ messageId, request, revision }: { messageId: number; request: RequestedWrite<Value>; revision: number | null },
) {
	const previous = writes.get(messageId);
	const pending = previous?.pending === request ? undefined : previous?.pending;
	const accepted = revision !== null && (previous?.accepted === undefined || previous.accepted.revision < revision)
		? { value: request.value, revision } : previous?.accepted;
	return setWrite(writes, messageId, { pending, accepted });
}

function observedWrites<Value>(writes: ReadonlyMap<number, WriteOverlay<Value>>, revision: number) {
	let next = writes;
	for (const [id, { pending, accepted }] of writes) {
		if (accepted !== undefined && accepted.revision <= revision) next = setWrite(next, id, { pending, accepted: undefined });
	}
	return next;
}

export function previewOnMessage(message: StoryMessage, variantId: number): Preview | null {
	return message.swipes[message.activeSwipe]?.id !== variantId && message.swipes.some((variant) => variant.id === variantId)
		? { messageId: message.id, variantId }
		: null;
}

export function retireStoryOverlays(
	state: StoryOverlays,
	window: StoryWindow,
	authority: { revision: number; activeGenerations: readonly { generationId: number }[] } | null,
): StoryOverlays {
	const { preview: requestedPreview } = state;
	const previewed = requestedPreview && window.messages.find((message) => message.id === requestedPreview.messageId);
	const preview = previewed && requestedPreview && previewOnMessage(previewed, requestedPreview.variantId) ? requestedPreview : null;
	const requestedSelections = observedWrites(state.requestedSelections, window.revision);
	const requestedMoves = observedWrites(state.requestedMoves, window.revision);
	const accepted = state.requestedGeneration?.accepted;
	const placed = accepted && window.messages.some((message) => message.swipes.some((variant) => variant.id === accepted.variantId));
	const ended = accepted && authority && authority.revision >= window.revision && window.revision > accepted.sentRevision &&
		!authority.activeGenerations.some((target) => target.generationId === accepted.generationId);
	const requestedGeneration = placed || ended ? null : state.requestedGeneration;
	return preview === state.preview && requestedSelections === state.requestedSelections && requestedMoves === state.requestedMoves && requestedGeneration === state.requestedGeneration
		? state
		: { preview, requestedSelections, requestedMoves, requestedGeneration };
}

const noMessages: readonly StoryMessage[] = [];

export function readStory({
	overlays, window, conversationId, historyFailed, loadingMore,
}: {
	overlays: StoryOverlays;
	window: StoryWindow | null;
	conversationId: number | null;
	historyFailed: boolean;
	loadingMore: boolean;
}): StoryState {
	const { preview: requestedPreview } = overlays;
	const message = requestedPreview && window?.messages.find((entry) => entry.id === requestedPreview.messageId);
	const preview = message && requestedPreview ? { ...requestedPreview, targetPosition: message.position } : null;
	const base = { ...overlays, preview, messages: window?.messages ?? noMessages };
	if (conversationId === null) return { ...base, status: "idle" };
	if (window === null) return { ...base, conversationId, status: historyFailed ? "error" : "loading-first" };
	return { ...base, ...window, status: "ready", conversationId, historyFailed, loadingMore };
}

// @approved
//  The placeholder shown for an exact empty Variant. Presentation-only: the
// stored content is never rewritten to contain it.
export const EMPTY_VARIANT_PLACEHOLDER = "(empty alternative)";

// @approved
//  The content to render for one Variant: the stored text, or the
// presentation-only placeholder for exact empty content.
export const visibleVariantContent = (variant: StoryVariant): string =>
	variant.empty ? EMPTY_VARIANT_PLACEHOLDER : variant.content ?? "";

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
	if (!isStoryReady(state) || state.preview !== null) return { kind: "blocked" };
	const message = state.messages.find((entry) => entry.id === messageId);
	if (message === undefined) return { kind: "blocked" };
	const target = message.swipes.find((variant) => variant.id === variantId);
	if (target === undefined) return { kind: "blocked" };
	if (displayedVariantId(state, message) === target.id) return { kind: "noop" };
	if (!state.page.hasNewer && !state.messages.some((later) => later.position > message.position)) return { kind: "immediate", messageId, variantId };
	return state.requestedSelections.has(messageId) ? { kind: "blocked" } : { kind: "preview", messageId, variantId };
};

export const displayedVariantId = (
	state: Pick<StoryState, "preview" | "requestedSelections" | "requestedGeneration">,
	message: StoryMessage,
): number | null => {
	if (state.preview?.messageId === message.id) return state.preview.variantId;
	if (hasRequestedSwipe(state, message.id)) return requestedSwipeId;
	const selection = state.requestedSelections.get(message.id);
	const requested = selection?.pending?.value ?? selection?.accepted?.value;
	if (requested !== undefined && message.swipes.some((variant) => variant.id === requested)) return requested;
	return message.swipes[message.activeSwipe]?.id ?? null;
};

export const shownVariant = (state: StoryState, message: StoryMessage): StoryVariant | undefined => {
	const id = displayedVariantId(state, message);
	return message.swipes.find((variant) => variant.id === id);
};

const without = <Value>(requested: ReadonlyMap<number, Value>, messageId: number) => {
	const next = new Map(requested);
	next.delete(messageId);
	return next;
};

// @approved
//  The Message the writer sees, with its Requested Moves in place of the persisted ones and, during a Requested
// Swipe, an empty Variant selected at the end until a page places the real one.
export const shownMessage = (state: StoryState, message: StoryMessage): StoryMessage => {
	const overlay = state.requestedMoves.get(message.id);
	const moves = overlay?.pending?.value ?? overlay?.accepted?.value;
	const shown = moves === undefined ? message : { ...message, moves };
	if (!hasRequestedSwipe(state, message.id)) return shown;
	const requested = { id: requestedSwipeId, position: message.swipes.length + 1, content: "", hasReasoning: false, empty: true };
	return { ...shown, activeSwipe: message.swipes.length, swipes: [...message.swipes, requested] };
};

const requestedSwipeId = -1;

export const hasRequestedSwipe = (state: Pick<StoryOverlays, "requestedGeneration">, messageId: number): boolean =>
	state.requestedGeneration?.request.kind === "sibling" && state.requestedGeneration.request.messageId === messageId;

// @approved
//  Mirrors the server's reusableHumanMessageId: a Send repeating the trailing human Message's text and Moves reuses it.
export const reusesTrailingHumanMessage = (state: StoryState, humanParticipantId: number | null, content: string, moves: BoxMoves | undefined): boolean => {
	const latest = !isStoryReady(state) || state.page.hasNewer ? undefined : state.messages.at(-1);
	return latest !== undefined && humanParticipantId !== null && latest.authorParticipantId === humanParticipantId &&
		shownVariant(state, latest)?.content === content && sameMoves(shownMessage(state, latest).moves, moves);
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
