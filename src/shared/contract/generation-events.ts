import { Type, type Static } from "@sinclair/typebox";
import {
	conflictReasonOutcome,
	invalidOutcome,
	notFoundOutcome,
	notPlayableOutcome,
} from "./outcomes";

// The normalized Generation event vocabulary: the provider-neutral events a
// Model Client emits, the Generation runtime publishes at the SSE seam, and
// every client decodes before application behavior sees them. This module is
// the single runtime source for that vocabulary; the server produces these
// payloads and the client decodes them with these schemas, so the two sides
// can never drift into parallel shape declarations.

// Token accounting reported by a Model Client attempt. Every field is
// optional because providers report different subsets.
export const generationUsage = Type.Object({
	inputTokens: Type.Optional(Type.Number()),
	outputTokens: Type.Optional(Type.Number()),
	totalTokens: Type.Optional(Type.Number()),
});

export type GenerationUsage = Static<typeof generationUsage>;

export const generationFinishReason = Type.Union([
	Type.Literal("stop"),
	Type.Literal("length"),
	Type.Literal("other"),
]);

export type GenerationFinishReason = Static<typeof generationFinishReason>;

export const generationFailureKind = Type.Union([
	Type.Literal("cancelled"),
	Type.Literal("inactivity"),
	Type.Literal("transport"),
	Type.Literal("provider"),
	Type.Literal("protocol"),
]);

export type GenerationFailureKind = Static<typeof generationFailureKind>;

// The exhaustive normalized Generation event union. `failed` is part of the
// ordered stream like any other event; terminal ownership still travels in
// the separate complete/stopped/error frames.
export const generationEvent = Type.Union([
	Type.Object({ type: Type.Literal("content"), text: Type.String() }),
	Type.Object({ type: Type.Literal("reasoning"), text: Type.String() }),
	Type.Object({ type: Type.Literal("usage"), usage: generationUsage }),
	Type.Object({ type: Type.Literal("keepalive") }),
	Type.Object({ type: Type.Literal("finished"), finishReason: generationFinishReason }),
	Type.Object({
		type: Type.Literal("failed"),
		kind: generationFailureKind,
		message: Type.String(),
	}),
]);

export type GenerationEvent = Static<typeof generationEvent>;

export const generationStreamStatus = Type.Union([
	Type.Literal("active"),
	Type.Literal("complete"),
	Type.Literal("stopped"),
	Type.Literal("failed"),
]);

export type GenerationStreamStatus = Static<typeof generationStreamStatus>;

// Stable identity of one accepted Generation attempt and its Provisional
// Variant. Every state or terminal frame carries the complete target so a
// client observing concurrent attempts can reject a frame from another one.
export const generationAttemptTarget = Type.Object({
	conversationId: Type.Integer(),
	generationId: Type.Integer(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
});

export type GenerationAttemptTarget = Static<typeof generationAttemptTarget>;

export const matchesGenerationAttemptTarget = (
	expected: GenerationAttemptTarget,
	observed: GenerationAttemptTarget,
): boolean =>
	expected.conversationId === observed.conversationId &&
	expected.generationId === observed.generationId &&
	expected.messageId === observed.messageId &&
	expected.variantId === observed.variantId;

// The `state` frame payload: the authoritative accumulated snapshot the
// server sends whenever a reconnecting client cannot replay from its event
// position, and on every lifecycle change.
export const generationStatePayload = Type.Composite([
	generationAttemptTarget,
	Type.Object({
		outcome: Type.Literal("active-state"),
		content: Type.String(),
		reasoning: Type.String(),
		latestEventId: Type.Integer(),
		status: generationStreamStatus,
		terminalReason: Type.Union([Type.Null(), Type.String()]),
	}),
]);

export type GenerationStatePayload = Static<typeof generationStatePayload>;

// The `complete` frame payload: the Generation committed durably and the
// event position the terminal state covers.
export const generationAppliedPayload = Type.Composite([
	generationAttemptTarget,
	Type.Object({
		outcome: Type.Literal("applied"),
		latestEventId: Type.Integer(),
	}),
]);

export type GenerationAppliedPayload = Static<typeof generationAppliedPayload>;

// The `stopped` frame payload: the Generation was stopped by an explicit
// command and is not a failure.
export const generationStoppedPayload = Type.Composite([
	generationAttemptTarget,
	Type.Object({ outcome: Type.Literal("stopped") }),
]);

export type GenerationStoppedPayload = Static<typeof generationStoppedPayload>;

// The `error` frame payload: the terminal outcomes a Generation stream
// reports. `failed` is the only outcome the subscription route emits today;
// the remaining members are the shared Conversation outcome vocabulary so a
// stream can report the same typed failures a start request reports.
const failedGenerationOutcome = Type.Object({
	outcome: Type.Literal("failed"),
	reason: Type.String(),
});

export const generationSubscriptionFailurePayload = Type.Union([
	failedGenerationOutcome,
	notFoundOutcome,
	notPlayableOutcome,
	invalidOutcome,
	conflictReasonOutcome,
]);

export const generationFailurePayload = Type.Union([
	Type.Composite([generationAttemptTarget, failedGenerationOutcome]),
	Type.Composite([generationAttemptTarget, notFoundOutcome]),
	Type.Composite([generationAttemptTarget, notPlayableOutcome]),
	Type.Composite([generationAttemptTarget, invalidOutcome]),
	Type.Composite([generationAttemptTarget, conflictReasonOutcome]),
]);

export type GenerationFailurePayload = Static<typeof generationFailurePayload>;
