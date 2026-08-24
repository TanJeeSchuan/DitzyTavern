import { describe, expect, test } from "bun:test";
import { incompleteSetupCopy } from "./cast-complete";
import type { ConversationSummary } from "./conversation";

// The presentation is fed a server-derived snapshot; these fixtures shape
// only the fields the copy reads (playable, controlValidity, control,
// capabilities) without re-deriving any domain rule.

const snapshot = (overrides: {
	playable?: boolean;
	humanParticipantId?: number | null;
	modelParticipantId?: number | null;
	composeAvailable?: boolean;
}): ConversationSummary => {
	const humanParticipantId =
		overrides.humanParticipantId !== undefined
			? overrides.humanParticipantId
			: 1;
	const modelParticipantId =
		overrides.modelParticipantId !== undefined
			? overrides.modelParticipantId
			: 2;
	const playable = overrides.playable ?? (humanParticipantId !== null && modelParticipantId !== null);
	const composeAvailable = overrides.composeAvailable ?? playable;
	return {
		id: 1,
		name: "lantern-house",
		revision: 3,
		cast: [],
		control: { humanParticipantId, modelParticipantId },
		controlValidity: {
			valid: playable,
			reason: playable ? null : "missing-seat",
		},
		playable,
		capabilities: {
			compose: { available: composeAvailable, reason: composeAvailable ? null : "conversation-not-playable" },
			generate: { available: composeAvailable, reason: composeAvailable ? null : "conversation-not-playable" },
			swipe: { available: composeAvailable, reason: composeAvailable ? null : "conversation-not-playable" },
		},
	};
};

describe("incompleteSetupCopy", () => {
	test("returns null for a playable Conversation so no setup surface appears", () => {
		expect(incompleteSetupCopy(snapshot({}))).toBeNull();
	});

	test("a zero-seat imported archive shows both seats missing and play actions withheld", () => {
		const copy = incompleteSetupCopy(
			snapshot({ humanParticipantId: null, modelParticipantId: null }),
		);
		expect(copy).not.toBeNull();
		expect(copy?.missingSeats).toEqual(["human", "model"]);
		expect(copy?.heading).toContain("not playable");
		expect(copy?.body).toContain("readable, editable");
		expect(copy?.playActionsWithheld).toBe(true);
		// Completion is derived: the first added Participant fills human,
		// the second model — no status toggle exists.
		expect(copy?.completion).toContain("first added Participant");
		expect(copy?.completion).toContain("second");
	});

	test("a one-seat import names the single missing seat and the preserved assignment", () => {
		const copy = incompleteSetupCopy(
			snapshot({ humanParticipantId: 1, modelParticipantId: null }),
		);
		expect(copy?.missingSeats).toEqual(["model"]);
		expect(copy?.playActionsWithheld).toBe(true);
		expect(copy?.completion).toContain("Responding-as (model)");
		expect(copy?.completion).toContain("Writing-as (human)");
		expect(copy?.completion).toContain("preserved");
	});

	test("a human-only gap is worded as filling the Writing-as seat while the model seat stays put", () => {
		const copy = incompleteSetupCopy(
			snapshot({ humanParticipantId: null, modelParticipantId: 2 }),
		);
		expect(copy?.missingSeats).toEqual(["human"]);
		expect(copy?.completion).toContain("Writing-as (human)");
		expect(copy?.completion).toContain("Responding-as (model)");
		expect(copy?.completion).toContain("preserved");
	});

	test("after the missing Participant is added the Conversation derives playability and the copy disappears", () => {
		const incomplete = incompleteSetupCopy(
			snapshot({ humanParticipantId: 1, modelParticipantId: null }),
		);
		expect(incomplete).not.toBeNull();
		// The authoritative snapshot after completion carries both seats.
		expect(incompleteSetupCopy(snapshot({ humanParticipantId: 1, modelParticipantId: 2 }))).toBeNull();
	});
});