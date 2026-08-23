import { describe, expect, test } from "bun:test";
import type { SaveParticipantAsCharacterOutcome } from "./conversation";
import { presentSaveParticipantOutcome } from "./cast-save";

// Focused UI-boundary tests for the Cast drawer's Save as Character
// presentation. These shape outcome wording and navigation state only; the
// workflow domain matrix lives behind the server-side interface tests.

const applied = (
	overrides: Partial<
		Extract<SaveParticipantAsCharacterOutcome, { status: "applied" }>
	> = {},
): Extract<SaveParticipantAsCharacterOutcome, { status: "applied" }> => ({
	status: "applied",
	character: {
		id: 41,
		name: "Maren Voss",
		revision: 0,
		pinned: false,
		prompt: {
			systemInstruction: "",
			identity: "A lighthouse archivist.",
			scenario: "",
			exampleDialogue: "",
			postHistoryInstruction: "",
		},
		openings: ["Hello."],
	},
	...overrides,
});

const conflict = (): SaveParticipantAsCharacterOutcome => ({
	status: "conflict",
	currentConversation: {
		id: 1,
		name: "Host Chat",
		revision: 3,
		cast: [],
		control: { humanParticipantId: null, modelParticipantId: null },
		controlValidity: { valid: false, reason: "missing-seat" },
		playable: false,
		capabilities: {
			compose: { available: false, reason: "conversation-not-playable" },
			generate: { available: false, reason: "conversation-not-playable" },
			swipe: { available: false, reason: "conversation-not-playable" },
		},
		messages: [],
		data: [],
	},
});

describe("presentSaveParticipantOutcome", () => {
	test("a successful save offers navigation to the new Character and no ordinary notice", () => {
		const presentation = presentSaveParticipantOutcome(
			applied({ character: { ...applied().character, id: 7 } }),
			"Maren Voss",
		);
		expect(presentation.notice).toBeNull();
		expect(presentation.reloadConversation).toBe(false);
		expect(presentation.savedCharacter).toEqual({ id: 7, name: "Maren Voss" });
	});

	test("a revision conflict asks for the authoritative state and offers no navigation", () => {
		const presentation = presentSaveParticipantOutcome(conflict(), "Maren Voss");
		expect(presentation.savedCharacter).toBeNull();
		expect(presentation.reloadConversation).toBe(true);
		expect(presentation.notice).toContain("changed elsewhere");
	});

	test("a missing Participant names the Participant and offers no navigation", () => {
		const presentation = presentSaveParticipantOutcome(
			{ status: "not-found" },
			"Maren Voss (2)",
		);
		expect(presentation.savedCharacter).toBeNull();
		expect(presentation.reloadConversation).toBe(true);
		expect(presentation.notice).toContain("Maren Voss (2)");
	});

	test("a validation failure surfaces the typed reason without navigation", () => {
		const presentation = presentSaveParticipantOutcome(
			{ status: "invalid", reason: "An opening is blank." },
			"Maren Voss",
		);
		expect(presentation.savedCharacter).toBeNull();
		expect(presentation.reloadConversation).toBe(false);
		expect(presentation.notice).toBe("An opening is blank.");
	});

	test("a network failure is presented without navigation or reload", () => {
		const presentation = presentSaveParticipantOutcome(
			{ status: "network" },
			"Maren Voss",
		);
		expect(presentation.savedCharacter).toBeNull();
		expect(presentation.reloadConversation).toBe(false);
		expect(presentation.notice).toContain("could not be reached");
	});

	test("the presentation never carries draft data, so local drafts stay untouched", () => {
		const outcome = Object.freeze(applied());
		const participantLabel = Object.freeze("Maren Voss");
		const presentation = presentSaveParticipantOutcome(outcome, participantLabel);

		// The result exposes only notice and navigation state: there is no
		// draft, name, or openings field a caller could mistake for a reason
		// to reset the Participant editor's unsaved edits.
		expect(Object.keys(presentation).sort()).toEqual([
			"notice",
			"reloadConversation",
			"savedCharacter",
		]);
		// And the input was never mutated by the presentation.
		expect(outcome).toEqual(applied());
		expect(participantLabel).toBe("Maren Voss");
	});
});