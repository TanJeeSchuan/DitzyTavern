import { describe, expect, test } from "bun:test";
import {
	commandOutcome,
	CONVERSATION_CONFLICT_RELOAD_NOTICE,
	CONVERSATION_UNREACHABLE_NOTICE,
	LIBRARY_UNREACHABLE_NOTICE,
} from "./command-outcome";

// A stand-in for the typed server error payload unions: discriminated by
// `outcome`, each member carrying its own extra fields.
type Payload =
	| { outcome: "conflict"; currentConversation: { id: number } }
	| { outcome: "not-found" }
	| { outcome: "not-playable"; reason: string }
	| { outcome: "invalid"; reason: string };

type ClientOutcome =
	| { status: "conflict"; currentConversation: { id: number } }
	| { status: "not-found" }
	| { status: "not-playable"; reason: string }
	| { status: "invalid"; reason: string }
	| { status: "network" };

const map = (payload: Payload): ClientOutcome =>
	commandOutcome<Payload, ClientOutcome>(payload, {
		conflict: (p) => ({ status: "conflict", currentConversation: p.currentConversation }),
		"not-playable": (p) => ({ status: "not-playable", reason: p.reason }),
		invalid: (p) => ({ status: "invalid", reason: p.reason }),
	});

describe("commandOutcome", () => {
	test("handlers keyed by outcome receive the matching payload shape", () => {
		expect(map({ outcome: "conflict", currentConversation: { id: 7 } })).toEqual({
			status: "conflict",
			currentConversation: { id: 7 },
		});
		expect(map({ outcome: "invalid", reason: "Nope" })).toEqual({
			status: "invalid",
			reason: "Nope",
		});
		expect(map({ outcome: "not-playable", reason: "No cast" })).toEqual({
			status: "not-playable",
			reason: "No cast",
		});
	});

	test("not-found maps to its client outcome without a handler", () => {
		expect(map({ outcome: "not-found" })).toEqual({ status: "not-found" });
	});

	test("an outcome without a handler falls back to the network outcome", () => {
		const unmapped = commandOutcome<{ outcome: "failure"; message: string }, ClientOutcome>(
			{ outcome: "failure", message: "down" },
			{},
		);
		expect(unmapped).toEqual({ status: "network" });
	});

	test("the client status always equals the server outcome name", () => {
		const payloads: Payload[] = [
			{ outcome: "conflict", currentConversation: { id: 1 } },
			{ outcome: "not-found" },
			{ outcome: "not-playable", reason: "r" },
			{ outcome: "invalid", reason: "r" },
		];
		for (const payload of payloads) {
			const mapped = map(payload);
			expect(mapped.status).toBe(payload.outcome);
		}
	});

	test("the shared notices stay byte-identical to the wording already shipped", () => {
		expect(CONVERSATION_UNREACHABLE_NOTICE).toBe("The Conversation could not be reached.");
		expect(LIBRARY_UNREACHABLE_NOTICE).toBe("The Library could not be reached.");
		expect(CONVERSATION_CONFLICT_RELOAD_NOTICE).toBe(
			"The Conversation changed elsewhere; the current Cast was loaded.",
		);
	});
});
