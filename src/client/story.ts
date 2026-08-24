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
	// Whether the authoring Participant is still an active Cast member.
	inCast: boolean;
	// Index of the persisted selected Variant within `swipes`.
	activeSwipe: number;
	swipes: StoryVariant[];
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
	| { type: "swipe-selected"; messageId: number; variantId: number };

export const createStoryState = (): StoryState => ({
	conversationId: null,
	title: "",
	revision: null,
	messages: [],
	page: null,
	status: "idle",
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