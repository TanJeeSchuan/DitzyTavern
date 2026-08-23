import { describe, expect, test } from "bun:test";
import {
	presentRemovalOutcome,
	removalConfirmationCopy,
} from "./cast-remove";
import type { CommandOutcome } from "./conversation";

const seated = {
	eligible: false,
	reason: "control-assigned" as const,
	deletionMode: null,
	affectedGenerationCount: 0,
};

const tombstone = (affectedGenerationCount: number) => ({
	eligible: true,
	reason: null,
	deletionMode: "tombstone" as const,
	affectedGenerationCount,
});

const hardDelete = {
	eligible: true,
	reason: null,
	deletionMode: "hard-delete" as const,
	affectedGenerationCount: 0,
};

describe("removalConfirmationCopy", () => {
	test("a tombstoning removal names the mode and the exact regeneration loss before confirmation", () => {
		const copy = removalConfirmationCopy("Maren Voss", tombstone(1));
		expect(copy.title).toBe("Remove Maren Voss?");
		expect(copy.impact).toContain("tombstone");
		expect(copy.impact).toContain("1 Message will");
		expect(copy.impact).toContain("new sibling Variants");
		expect(copy.confirmLabel).toBe("Remove");
	});

	test("a tombstoning removal with no regeneration loss still explains history retention", () => {
		const copy = removalConfirmationCopy("Maren Voss", tombstone(0));
		expect(copy.impact).toContain("tombstone");
		expect(copy.impact).toContain("history keeps displaying");
		expect(copy.impact).not.toContain("Message");
	});

	test("a hard deletion states the permanent result", () => {
		const copy = removalConfirmationCopy("Juno Ashfeld", hardDelete);
		expect(copy.title).toBe("Remove Juno Ashfeld?");
		expect(copy.impact).toContain("permanently deletes");
		expect(copy.impact).not.toContain("tombstone");
		expect(copy.confirmLabel).toBe("Remove");
	});

	test("a seated Participant explains the Control change instead of an impact", () => {
		const copy = removalConfirmationCopy("Writer", seated);
		expect(copy.title).toBe("Writer cannot be removed");
		expect(copy.impact).toContain("Control seat");
		expect(copy.confirmLabel).toBe("Close");
	});
});

describe("presentRemovalOutcome", () => {
	const applied: CommandOutcome = {
		status: "applied",
		// SAFETY: the presentation only branches on status, so the snapshot
		// payload stays out of scope here.
		conversation: undefined as never,
	};

	test("an applied removal needs no notice and no reload", () => {
		expect(presentRemovalOutcome(applied, "Juno Ashfeld")).toEqual({
			notice: null,
			reloadConversation: false,
		});
	});

	test("the typed not-removable outcome explains the seat and reloads", () => {
		const presentation = presentRemovalOutcome(
			{ status: "not-removable", reason: "control-assigned" },
			"Juno Ashfeld",
		);
		expect(presentation.notice).toContain("Juno Ashfeld");
		expect(presentation.notice).toContain("Control seat");
		expect(presentation.reloadConversation).toBe(true);
	});

	test("conflicts and missing Participants reload the authoritative Cast", () => {
		expect(
			presentRemovalOutcome(
				{
					status: "conflict",
					// SAFETY: the presentation only branches on status, so the
					// authoritative snapshot payload stays out of scope here.
					currentConversation: undefined as never,
				},
				"Juno Ashfeld",
			).reloadConversation,
		).toBe(true);
		expect(
			presentRemovalOutcome({ status: "not-found" }, "Juno Ashfeld"),
		).toEqual({
			notice: "Juno Ashfeld is no longer in this Cast.",
			reloadConversation: true,
		});
	});

	test("validation and network failures surface as notices", () => {
		const invalid = presentRemovalOutcome(
			{ status: "invalid", reason: "Nope" },
			"Juno Ashfeld",
		);
		expect(invalid.notice).toBe("Nope");
		expect(invalid.reloadConversation).toBe(false);
		expect(presentRemovalOutcome({ status: "network" }, "Juno Ashfeld").notice).toBe(
			"The Conversation could not be reached.",
		);
	});
});