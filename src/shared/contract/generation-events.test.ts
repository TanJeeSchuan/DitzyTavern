import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";

import {
	generationAppliedPayload,
	generationEvent,
	generationFailurePayload,
	generationStatePayload,
	generationStoppedPayload,
} from "./generation-events";

const validGenerationEvents: readonly unknown[] = [
	{ type: "content", text: "Written output." },
	{ type: "reasoning", text: "Hidden thinking." },
	{ type: "usage", usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } },
	{ type: "usage", usage: {} },
	{ type: "usage", usage: { totalTokens: 14 } },
	{ type: "keepalive" },
	{ type: "finished", finishReason: "stop" },
	{ type: "finished", finishReason: "length" },
	{ type: "finished", finishReason: "other" },
	{ type: "failed", kind: "cancelled", message: "Generation was stopped." },
	{ type: "failed", kind: "inactivity", message: "The provider went quiet." },
	{ type: "failed", kind: "transport", message: "The request failed." },
	{ type: "failed", kind: "provider", message: "The provider rejected the request." },
	{ type: "failed", kind: "protocol", message: "The provider stream was malformed." },
];

describe("generationEvent", () => {
	test("accepts every normalized Generation event kind", () => {
		for (const event of validGenerationEvents) {
			expect(Value.Check(generationEvent, event)).toBe(true);
		}
	});

	test("rejects malformed event discriminants", () => {
		const malformed: readonly unknown[] = [
			{ type: "unknown-kind" },
			{ type: "Content", text: "case-sensitive discriminant" },
			{ type: "content" },
			{ type: "reasoning", text: 7 },
			{ type: "usage" },
			{ type: "usage", usage: { inputTokens: "11" } },
			{ type: "usage", usage: [] },
			{ type: "finished" },
			{ type: "finished", finishReason: "STOP" },
			{ type: "finished", finishReason: null },
			{ type: "failed", kind: "cancelled" },
			{ type: "failed", message: "missing kind" },
			{ type: "failed", kind: "mystery", message: "unknown failure kind" },
			{ type: "failed", kind: "transport" },
		];
		for (const event of malformed) {
			expect(Value.Check(generationEvent, event)).toBe(false);
		}
	});

	test("rejects non-object payloads", () => {
		for (const payload of [null, "content", 7, true, []]) {
			expect(Value.Check(generationEvent, payload)).toBe(false);
		}
	});
});

const validState = {
	outcome: "active-state",
	generationId: 7,
	conversationId: 42,
	messageId: 9,
	variantId: 10,
	content: "Partial output.",
	reasoning: "Partial reasoning.",
	latestEventId: 5,
	status: "active",
	terminalReason: null,
};

const validTarget = {
	conversationId: 42,
	generationId: 7,
	messageId: 9,
	variantId: 10,
};

describe("generationStatePayload", () => {
	test("accepts an active snapshot and a terminal snapshot", () => {
		expect(Value.Check(generationStatePayload, validState)).toBe(true);
		expect(Value.Check(generationStatePayload, {
			...validState,
			status: "failed",
			terminalReason: "The provider went quiet.",
		})).toBe(true);
	});

	test("rejects malformed state snapshots", () => {
		const malformed: readonly unknown[] = [
			{ ...validState, outcome: "state" },
			{ ...validState, generationId: "7" },
			{ ...validState, latestEventId: 5.5 },
			{ ...validState, status: "running" },
			{ ...validState, terminalReason: 3 },
			(({ outcome: _outcome, ...rest }: typeof validState) => rest)(validState),
			{ ...validState, content: null },
		];
		for (const payload of malformed) {
			expect(Value.Check(generationStatePayload, payload)).toBe(false);
		}
	});
});

describe("generationAppliedPayload", () => {
	test("accepts the applied terminal frame", () => {
		expect(Value.Check(generationAppliedPayload, {
			...validTarget,
			outcome: "applied",
			latestEventId: 5,
		})).toBe(true);
	});

	test("rejects incomplete applied frames", () => {
		const malformed: readonly unknown[] = [
			{ outcome: "applied" },
			{ outcome: "applied", generationId: 7 },
			{ outcome: "applied", generationId: 7, latestEventId: "5" },
			{ outcome: "done", generationId: 7, latestEventId: 5 },
		];
		for (const payload of malformed) {
			expect(Value.Check(generationAppliedPayload, payload)).toBe(false);
		}
	});
});

describe("generationStoppedPayload", () => {
	test("accepts the stopped terminal frame", () => {
		expect(Value.Check(generationStoppedPayload, {
			...validTarget,
			outcome: "stopped",
		})).toBe(true);
	});

	test("rejects incomplete stopped frames", () => {
		const malformed: readonly unknown[] = [
			{ outcome: "stopped" },
			{ outcome: "stopped", generationId: null },
			{ outcome: "halted", generationId: 7 },
		];
		for (const payload of malformed) {
			expect(Value.Check(generationStoppedPayload, payload)).toBe(false);
		}
	});
});

describe("generationFailurePayload", () => {
	test("accepts every terminal failure outcome the stream defines", () => {
		const valid: readonly unknown[] = [
			{ ...validTarget, outcome: "failed", reason: "Generation failed." },
			{ ...validTarget, outcome: "not-found" },
			{ ...validTarget, outcome: "not-playable", reason: "The Conversation is not playable." },
			{ ...validTarget, outcome: "invalid", reason: "The request was invalid." },
			{ ...validTarget, outcome: "conflict", reason: "The Conversation changed." },
		];
		for (const payload of valid) {
			expect(Value.Check(generationFailurePayload, payload)).toBe(true);
		}
	});

	test("rejects malformed failure frames", () => {
		// Excess properties stay wire-tolerant like every other shared
		// contract; a frame only fails when a required field is missing,
		// mistyped, or the outcome discriminant is unknown.
		const malformed: readonly unknown[] = [
			{ outcome: "failed" },
			{ outcome: "failed", reason: 7 },
			{ outcome: "expired" },
			{ outcome: "invalid" },
			{ outcome: 7 },
		];
		for (const payload of malformed) {
			expect(Value.Check(generationFailurePayload, payload)).toBe(false);
		}
	});
});
