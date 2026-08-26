// Pure state transitions for reading a Chat's native history. The view
// feeds typed history pages and command outcomes into this reducer, so page
// accumulation, selected-Variant updates, and empty-Variant placeholders are
// testable without a browser or a frontend framework.
//
// Imported Chats use exactly this model: their Messages came through the
// same paginated read seam and their Swipe navigation is the same
// revisioned Variant-selection behavior as every other Chat. Empty and
// duplicate Variants stay separate navigable positions; an exact empty
// Variant renders a presentation-only placeholder and its stored text is
// never modified.

import type { ChatHistoryPage, ChatHistoryVariant } from "./chat-history";

// A reading view of one Variant: the stored content plus whether the
// presentation should show the exact-empty placeholder instead.
export interface StoryVariant {
	id: number;
	position: number;
	content: string;
	// Presentation-only: true when the stored content is exactly empty. The
	// placeholder substitutes rendering only; the stored text stays as-is.
	empty: boolean;
}

export interface StoryMessage {
	id: number;
	position: number;
	timestamp: string;
	// Immutable Author Stamp name (the captured resolved Participant name).
	authorName: string | null;
	authorParticipantId: number | null;
	// Whether the authoring Participant is still an active Cast member.
	inCast: boolean;
	// Index of the persisted selected Variant within `swipes`.
	activeSwipe: number;
	swipes: StoryVariant[];
}

export interface StoryPreviewState {
	messageId: number;
	targetPosition: number;
	variantId: number;
	priorVariantId: number | null;
	noticeOpen: boolean;
}

export interface PreviewSelectionRequest {
	conversationId: number;
	expectedRevision: number;
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
	// Authoritative Conversation revision as of the last read page; the
	// revisioned command seam needs it when the full snapshot is not loaded.
	revision: number | null;
	// Accumulated stable chronological Messages, deduplicated by Message id.
	// The first page is the latest window; older pages prepend above it.
	messages: StoryMessage[];
	page: StoryPaging | null;
	status: "idle" | "loading-first" | "loading-more" | "ready" | "error";
	preview: StoryPreviewState | null;
}

export type StoryAction =
	// A different Chat is being opened (or the current one re-requested);
	// the reader resets and loads the first page fresh.
	| { type: "chat-opened"; conversationId: number }
	// The first page arrives: the latest window of history. It replaces any
	// accumulated messages.
	| { type: "first-page"; page: ChatHistoryPage }
	// An older page arrives; its Messages prepend to the accumulated
	// sequence with no overlap.
	| { type: "next-page-arrived"; page: ChatHistoryPage }
	// The view requested an older page; further requests are ignored until
	// it arrives or fails.
	| { type: "load-more-started" }
	| { type: "history-failed" }
	// An optimistic selected-Variant update following the revisioned
	// select-variant command; the server response is authoritative but the
	// local position updates immediately so reading never waits.
	| { type: "swipe-selected"; messageId: number; variantId: number }
	| { type: "preview-started"; messageId: number; variantId: number }
	| { type: "preview-notice-opened" }
	| { type: "preview-notice-closed" }
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
});

// An exact empty Variant is presented with a placeholder; whitespace-only
// content is not empty and renders as stored.
const toStoryVariant = (variant: ChatHistoryVariant): StoryVariant => ({
	id: variant.id,
	position: variant.position,
	content: variant.content,
	empty: variant.content === "",
});

const toStoryMessage = (message: ChatHistoryPage["messages"][number]): StoryMessage => ({
	id: message.id,
	position: message.position,
	timestamp: message.timestamp,
	authorName: message.author?.capturedName ?? null,
	authorParticipantId: message.author?.participantId ?? null,
	inCast: message.author?.inCast ?? false,
	activeSwipe: Math.max(
		0,
		message.variants.findIndex((variant) => variant.selected),
	),
	swipes: message.variants.map(toStoryVariant),
});

const prependUnique = (
	existing: readonly StoryMessage[],
	incoming: readonly StoryMessage[],
): StoryMessage[] => {
	const known = new Set(existing.map((message) => message.id));
	const fresh = incoming.filter((message) => !known.has(message.id));
	return [...fresh, ...existing];
};

export function reduceStory(state: StoryState, action: StoryAction): StoryState {
	switch (action.type) {
		case "chat-opened":
			return {
				...createStoryState(),
				conversationId: action.conversationId,
				status: "loading-first",
			};
		case "first-page":
			if (state.conversationId !== action.page.conversationId) return state;
			return {
				...state,
				title: action.page.name,
				revision: action.page.revision,
				messages: action.page.messages.map(toStoryMessage),
				page: { ...action.page.page },
				status: "ready",
				preview: null,
			};
		case "next-page-arrived":
			if (state.conversationId !== action.page.conversationId) return state;
			return {
				...state,
				revision: action.page.revision,
				messages: prependUnique(state.messages, action.page.messages.map(toStoryMessage)),
				page: { ...action.page.page },
				status: "ready",
			};
		case "load-more-started":
			return state.status === "ready" && state.page?.hasOlder === true
				? { ...state, status: "loading-more" }
				: state;
		case "history-failed":
			return state.status === "loading-first" || state.status === "loading-more"
				? { ...state, status: "error" }
				: state;
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
					noticeOpen: true,
				},
			};
		}
		case "preview-notice-opened":
			return state.preview === null
				? state
				: { ...state, preview: { ...state.preview, noticeOpen: true } };
		case "preview-notice-closed":
			return state.preview === null
				? state
				: { ...state, preview: { ...state.preview, noticeOpen: false } };
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

// The placeholder shown for an exact empty Variant. Presentation-only: the
// stored content is never rewritten to contain it.
export const EMPTY_VARIANT_PLACEHOLDER = "(empty alternative)";

// The content to render for one Variant: the stored text, or the
// presentation-only placeholder for exact empty content.
export const visibleVariantContent = (variant: StoryVariant): string =>
	variant.empty ? EMPTY_VARIANT_PLACEHOLDER : variant.content;

// Moves a StoryMessage's active swipe within bounds, mirroring the swipe
// controls' positional navigation. Applies after a local swipe command; the
// underlying message is not mutated.
export const moveActiveSwipe = (
	message: StoryMessage,
	direction: -1 | 1,
): number =>
	Math.min(
		message.swipes.length - 1,
		Math.max(0, message.activeSwipe + direction),
	);

// The Revision window is the latest two model-authored Messages plus the
// human-authored Messages between them. It is derived from the story read
// model and the current model Control assignment, never persisted locally.
export const deriveRevisionWindow = (
	messages: readonly StoryMessage[],
	modelParticipantId: number | null,
): ReadonlySet<number> => {
	if (modelParticipantId === null) return new Set<number>();
	const chronological = [...messages].sort((left, right) => left.position - right.position);
	const modelMessages = chronological.filter(
		(message) => message.authorParticipantId === modelParticipantId,
	);
	if (modelMessages.length === 0) return new Set<number>();
	const latestModels = modelMessages.slice(-2);
	const firstModelPosition = latestModels[0]?.position;
	const lastModelPosition = latestModels[latestModels.length - 1]?.position;
	if (firstModelPosition === undefined || lastModelPosition === undefined) {
		return new Set<number>();
	}

	return new Set(
		chronological
			.filter((message) => {
				const inWindow =
					message.position >= firstModelPosition &&
					message.position <= lastModelPosition;
				const isLatestModel = message.authorParticipantId === modelParticipantId;
				const isHumanAuthored =
					message.authorParticipantId !== null && !isLatestModel;
				return inWindow && (isLatestModel || isHumanAuthored);
			})
			.map((message) => message.id),
	);
};

export type StoryVariantSelection =
	| { kind: "noop" }
	| { kind: "blocked" }
	| { kind: "immediate"; messageId: number; variantId: number }
	| { kind: "preview"; messageId: number; variantId: number };

// Classifies a requested Swipe before any server command is sent. The caller
// supplies the derived Revision window so this pure seam can be shared by the
// UI and transport tests without recreating Conversation rules.
export const classifyVariantSelection = (
	state: StoryState,
	messageId: number,
	variantId: number,
	revisionWindow: ReadonlySet<number>,
): StoryVariantSelection => {
	if (state.preview !== null) return { kind: "blocked" };
	const message = state.messages.find((entry) => entry.id === messageId);
	if (message === undefined) return { kind: "blocked" };
	const target = message.swipes.find((variant) => variant.id === variantId);
	if (target === undefined) return { kind: "blocked" };
	if (message.swipes[message.activeSwipe]?.id === target.id) return { kind: "noop" };
	return revisionWindow.has(message.id)
		? { kind: "immediate", messageId, variantId }
		: { kind: "preview", messageId, variantId };
};

// The visible Variant is local-only while Preview mode is active. The stored
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

// Navigation is the one client action that may discard a local Preview. The
// caller owns the confirmation dialog; this pure predicate keeps that policy
// testable without a browser and avoids warning when the selected Chat did
// not actually change.
export const previewNavigationNeedsConfirmation = (
	preview: StoryPreviewState | null,
	currentConversationId: string | number | null,
	nextConversationId: string | number,
): boolean =>
	preview !== null && String(currentConversationId) !== String(nextConversationId);

export type PreviewConfirmationResult<Result> =
	| { status: "not-sent" }
	| { status: "sent"; result: Result };

// A transport boundary for confirmation: no request is sent without the
// matching client preview, and one ordinary revision-guarded command is sent
// for a valid confirmation. The concrete Conversation transport stays
// outside the pure story reducer.
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
