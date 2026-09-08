import { describe, expect, test } from "bun:test";
import {
	affectedConversationsLabel,
	presetDeletionConfirmationCopy,
	presetDeletionImpactChangedNotice,
	presetDeletionResultNotice,
	presetSelectionFeedbackLabel,
} from "./prompt-preset-presentation";

// Focused UI-boundary tests for the Prompt Preset library's deletion
// presentation: the affected-Conversation count label and confirmation copy
// that states exactly which Chats move to Default. The deletion behavior
// itself lives behind the server seam tests.
describe("affectedConversationsLabel", () => {
	test("an unselected preset reads as unused", () => {
		expect(affectedConversationsLabel(0)).toBe("Not selected by any Chat");
	});

	test("a single affected Chat reads grammatically", () => {
		expect(affectedConversationsLabel(1)).toBe("Selected by 1 Chat");
	});

	test("several affected Chats name the count", () => {
		expect(affectedConversationsLabel(4)).toBe("Selected by 4 Chats");
	});
});

describe("presetDeletionConfirmationCopy", () => {
	test("the confirmation names the affected Chats and the Default destination", () => {
		const copy = presetDeletionConfirmationCopy("Story", 3);
		expect(copy.title).toBe("Delete Story?");
		expect(copy.impact).toContain("Selected by 3 Chats");
		expect(copy.impact).toContain("Default preset");
		expect(copy.confirmLabel).toBe("Yes, delete preset");
	});

	test("an unselected preset still states the same operation", () => {
		const copy = presetDeletionConfirmationCopy("Draft", 0);
		expect(copy.impact).toContain("Not selected by any Chat");
		expect(copy.impact).toContain("Default preset");
	});
});

describe("presetSelectionFeedbackLabel", () => {
	test("the selected row and the selectable row state their states", () => {
		expect(presetSelectionFeedbackLabel(true)).toBe("Selected for this Chat");
		expect(presetSelectionFeedbackLabel(false)).toBe("Select for this Chat");
	});
});

describe("presetDeletionImpactChangedNotice", () => {
	test("a rejected deletion states the current impact and that nothing was removed", () => {
		expect(presetDeletionImpactChangedNotice("Story", 2))
			.toBe("Deletion impact changed: Selected by 2 Chats. Confirm deletion again to remove \"Story\".");
	});
});

describe("presetDeletionResultNotice", () => {
	test("a deletion without affected Chats says so", () => {
		expect(presetDeletionResultNotice("Draft", { reassignedConversationCount: 0 }))
			.toBe("Deleted \"Draft\". No Chat was using it.");
	});

	test("one affected Chat reads grammatically", () => {
		expect(presetDeletionResultNotice("Story", { reassignedConversationCount: 1 }))
			.toBe("Deleted \"Story\". 1 Chat moved to the Default preset.");
	});

	test("several affected Chats name the count", () => {
		expect(presetDeletionResultNotice("Story", { reassignedConversationCount: 5 }))
			.toBe("Deleted \"Story\". 5 Chats moved to the Default preset.");
	});
});
