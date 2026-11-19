import { describe, expect, test } from "bun:test";
import type {
	ConversationPromptPreset,
	PromptOutgoingRole,
	ResolvedPromptPresetSlot,
} from "../shared/contract/prompt-preset";
import { dirtyBlockPatches, draftIsDirty, draftToPatch, type BlockDraft } from "./prompt-preset-editor-state";

const instructionSlot = (id: number, name: string, content: string): ResolvedPromptPresetSlot => ({
	id,
	reference: "instruction",
	enabled: true,
	role: "system",
	name,
	content,
});

const identitySlot = (id: number, role: PromptOutgoingRole): ResolvedPromptPresetSlot => ({
	id,
	reference: "model-identity",
	enabled: true,
	role,
	sourceName: "Aster",
	content: "Aster's identity.",
});

const historySlot = (id: number): ResolvedPromptPresetSlot => ({
	id,
	reference: "history",
	enabled: true,
	entryCount: 3,
});

const recipe = (id: number, slots: ResolvedPromptPresetSlot[]): ConversationPromptPreset => ({
	id,
	name: `Preset ${id}`,
	slots,
});

const contentDraft = (content: string): BlockDraft => ({
	kind: "content",
	name: "Voice",
	content,
	role: "system",
});

const roleDraft = (role: PromptOutgoingRole): BlockDraft => ({ kind: "role", role });

describe("the draft-to-patch rule", () => {
	test("a referenced slot drafts its outgoing role and an instruction drafts its authored fields", () => {
		expect(draftToPatch(identitySlot(6, "assistant"), roleDraft("user")))
			.toEqual({ occurrenceId: 6, type: "role", role: "user" });
		expect(draftToPatch(instructionSlot(5, "Voice", "Write plainly."), contentDraft("Write warmly.")))
			.toEqual({ occurrenceId: 5, type: "content", name: "Voice", content: "Write warmly.", role: "system" });
	});

	test("a clean draft produces no patch", () => {
		expect(draftToPatch(identitySlot(6, "assistant"), roleDraft("assistant"))).toBeNull();
		expect(draftToPatch(instructionSlot(5, "Voice", "Write plainly."), contentDraft("Write plainly.")))
			.toBeNull();
	});

	test("enablement drafts save alone or with authored fields", () => {
		const preset = recipe(7, [historySlot(9), instructionSlot(5, "Voice", "Write plainly.")]);
		const drafts = {
			9: { kind: "enabled", enabled: false },
			5: { kind: "content", name: "Voice", content: "Write warmly.", role: "system", enabled: false },
		} satisfies Record<number, BlockDraft>;
		expect(dirtyBlockPatches(preset, drafts).patches).toEqual([
			{ occurrenceId: 9, type: "enabled", enabled: false },
			{ occurrenceId: 5, type: "content", name: "Voice", content: "Write warmly.", role: "system", enabled: false },
		]);
		expect(draftToPatch(historySlot(9), { kind: "enabled", enabled: true })).toBeNull();
	});

	test("a wrong-kind or history draft produces no patch and is never dirty", () => {
		expect(draftToPatch(identitySlot(6, "assistant"), contentDraft("Write warmly."))).toBeNull();
		expect(draftToPatch(instructionSlot(5, "Voice", "Write plainly."), roleDraft("user"))).toBeNull();
		expect(draftToPatch(historySlot(9), roleDraft("user"))).toBeNull();
		expect(draftToPatch(historySlot(9), contentDraft("Write warmly."))).toBeNull();
		expect(draftIsDirty(historySlot(9), roleDraft("user"))).toBe(false);
	});

	test("only dirty occurrences appear in the save batch", () => {
		const preset = recipe(7, [
			instructionSlot(5, "Voice", "Write plainly."),
			identitySlot(6, "assistant"),
			identitySlot(8, "system"),
		]);
		const drafts = {
			5: contentDraft("Write warmly."),
			8: roleDraft("system"), // clean — matches its slot role
		};
		expect(dirtyBlockPatches(preset, drafts).patches).toEqual([
			{ occurrenceId: 5, type: "content", name: "Voice", content: "Write warmly.", role: "system" },
		]);
		expect(dirtyBlockPatches(preset, {}).patches).toEqual([]);
	});

	test("the save batch records exactly which drafts were submitted", () => {
		const preset = recipe(7, [
			instructionSlot(5, "Voice", "Write plainly."),
			identitySlot(6, "assistant"),
			historySlot(9),
		]);
		const drafts = {
			5: contentDraft("Write warmly."),
			6: roleDraft("user"),
			9: roleDraft("system"), // history accepts no draft — never in the batch
		};
		const { patches, submitted } = dirtyBlockPatches(preset, drafts);
		expect(patches).toEqual([
			{ occurrenceId: 5, type: "content", name: "Voice", content: "Write warmly.", role: "system" },
			{ occurrenceId: 6, type: "role", role: "user" },
		]);
		expect(submitted).toEqual({ 5: drafts[5], 6: drafts[6] });
	});

	test("duplicate occurrences are addressed independently by their own ids", () => {
		const first = identitySlot(6, "assistant");
		const second = identitySlot(9, "assistant");
		const preset = recipe(7, [first, second]);
		const drafts = { 9: roleDraft("user") };

		expect(draftToPatch(first, roleDraft("assistant"))).toBeNull();
		expect(draftToPatch(second, drafts[9])).toEqual({ occurrenceId: 9, type: "role", role: "user" });
		expect(dirtyDraftSummary(preset, drafts)).toEqual({ dirty: true, count: 1 });
		expect(dirtyBlockPatches(preset, drafts).patches).toEqual([
			{ occurrenceId: 9, type: "role", role: "user" },
		]);
	});
});
