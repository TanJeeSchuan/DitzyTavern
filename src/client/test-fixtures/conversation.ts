import type { ChatHistoryMessage, ChatHistoryPage, ChatHistoryVariant, ConversationSummary } from "../../shared/contract/conversation-schema";
import type { GenerationSessionTarget } from "../generation-sessions";
import { boxes, boxSetups } from "./box-setups";

export const conversationSummary = (overrides: Partial<ConversationSummary> = {}): ConversationSummary => ({
	id: 1,
	name: "Seaside Letters",
	revision: 7,
	boxSetups, boxes, boxVersions: {}, forkedFrom: null, background: null, cast: [],
	control: { humanParticipantId: null, modelParticipantId: null },
	controlValidity: { valid: false, reason: "missing-seat" },
	playable: false,
	capabilities: {
		compose: { available: false, reason: "conversation-not-playable" },
		generate: { available: false, reason: "conversation-not-playable" },
		swipe: { available: false, reason: "conversation-not-playable" },
	},
	activeGenerations: [],
	...overrides,
});

export const historyPage = (
	{ page, ...overrides }: Omit<Partial<ChatHistoryPage>, "page"> & { page?: Partial<ChatHistoryPage["page"]> } = {},
): ChatHistoryPage => ({
	conversationId: 7,
	name: "Lantern House",
	revision: 3,
	cast: [{ id: 1, position: 1, name: "Writer" }],
	page: { index: 1, pageSize: 2, totalMessages: 4, totalPages: 2, hasOlder: true, hasNewer: false, ...page },
	messages: [],
	...overrides,
});

const timestamp = "2026-01-01T00:00:00.000Z";

export const variant = (overrides: Partial<ChatHistoryVariant> = {}): ChatHistoryVariant => ({
	id: 100, position: 1, content: "Once", empty: false, hasReasoning: false, selected: true, timestamp,
	...overrides,
});

export const historyMessage = (overrides: Partial<ChatHistoryMessage> = {}): ChatHistoryMessage => ({
	id: 10, position: 1, timestamp,
	authorRole: "model",
	modelParticipantIdAtCreation: null,
	continuable: true,
	swipe: { eligible: true, reason: null },
	author: { participantId: 1, capturedName: "Writer", inCast: true },
	variants: [variant()],
	moves: {},
	...overrides,
});

export const generationTarget = (generationId: number, overrides: Partial<GenerationSessionTarget> = {}): GenerationSessionTarget => ({
	generationId, messageId: 900 + generationId, variantId: 9_000 + generationId,
	...overrides,
});

export type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const installFetch = (handler: FetchHandler): void => {
	globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
};
