import { describe, expect, test } from "bun:test";
import type {
	ConversationPromptPreset,
	PromptOutgoingRole,
	ResolvedPromptPresetSlot,
} from "../shared/contract/prompt-preset";
import {
	conversationOperationApplies,
	conversationOperationClaim,
	createPromptPresetEditorState,
	operationApplies,
	operationClaim,
	readApplies,
	readClaim,
	reducePromptPresetEditorState,
	type BlockDraft,
	type PromptPresetEditorState,
} from "./prompt-preset-editor-state";

// The popup's response-ownership, draft-reconciliation and leave rules are
// pure decisions, so they are tested here without rendering the dialog. The
// transport and the rendered JSX stay thin wiring over these transitions.

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

const openState = (): PromptPresetEditorState =>
	createPromptPresetEditorState("open:1", 3);

const adopt = (
	state: PromptPresetEditorState,
	selected: ConversationPromptPreset,
): PromptPresetEditorState =>
	reducePromptPresetEditorState(state, { type: "recipe-adopted", claim: readClaim(state), selected });

describe("response ownership", () => {
	test("a stale read is rejected", () => {
		let state = openState();
		state = reducePromptPresetEditorState(state, { type: "read-started" });
		const stale = readClaim(state);
		state = reducePromptPresetEditorState(state, { type: "read-started" });
		const current = readClaim(state);
		const selected = recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]);

		state = reducePromptPresetEditorState(state, { type: "recipe-adopted", claim: stale, selected });
		expect(state.view.status).toBe("loading");

		state = reducePromptPresetEditorState(state, { type: "recipe-adopted", claim: current, selected });
		expect(state.view).toEqual({ status: "ready", presets: [], selected });
	});

	test("an older mutation response is dropped", () => {
		let state = openState();
		state = reducePromptPresetEditorState(state, { type: "operation-started", operation: "busy" });
		const older = operationClaim(state);
		state = reducePromptPresetEditorState(state, { type: "operation-started", operation: "busy" });
		const newer = operationClaim(state);

		expect(operationApplies(state, older)).toBe(false);
		expect(operationApplies(state, newer)).toBe(true);

		state = reducePromptPresetEditorState(state, { type: "operation-settled", claim: older });
		expect(state.operation).toBe("busy");
		state = reducePromptPresetEditorState(state, { type: "operation-settled", claim: newer });
		expect(state.operation).toBeNull();
	});

	test("a response from a replaced popup session is rejected", () => {
		let state = openState();
		state = reducePromptPresetEditorState(state, { type: "read-started" });
		const claim = readClaim(state);
		state = reducePromptPresetEditorState(state, {
			type: "session-changed",
			sessionKey: "open:2",
			conversationRevision: 4,
		});
		state = reducePromptPresetEditorState(state, {
			type: "recipe-adopted",
			claim,
			selected: recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]),
		});

		expect(readApplies(state, claim)).toBe(false);
		expect(state.view).toEqual({ status: "loading" });
	});

	test("a newer Conversation snapshot drops a pending Conversation command", () => {
		let state = openState();
		state = reducePromptPresetEditorState(state, {
			type: "operation-started",
			operation: "busy",
			conversationOperation: true,
		});
		const claim = conversationOperationClaim(state);

		state = reducePromptPresetEditorState(state, {
			type: "conversation-revision-changed",
			conversationRevision: 4,
		});

		expect(conversationOperationApplies(state, claim)).toBe(false);
	});
});

describe("draft reconciliation", () => {
	test("a submitted draft retires only when it still matches", () => {
		let state = openState();
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		const submitted = contentDraft("Write warmly.");
		state = reducePromptPresetEditorState(state, { type: "draft-changed", blockId: 5, draft: submitted });
		state = reducePromptPresetEditorState(state, { type: "drafts-submitted", submitted: { 5: submitted } });

		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write warmly.")]));

		expect(state.drafts[5]).toBeUndefined();
	});

	test("a newer local edit survives a save's reconciliation", () => {
		let state = openState();
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		const submitted = contentDraft("Write warmly.");
		state = reducePromptPresetEditorState(state, { type: "draft-changed", blockId: 5, draft: submitted });
		state = reducePromptPresetEditorState(state, { type: "drafts-submitted", submitted: { 5: submitted } });
		const newerEdit = contentDraft("Write warmly, in second person.");
		state = reducePromptPresetEditorState(state, { type: "draft-changed", blockId: 5, draft: newerEdit });

		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write warmly.")]));

		expect(state.drafts[5]).toEqual(newerEdit);
	});

	test("drafts clear when the selected preset changes", () => {
		let state = openState();
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		state = reducePromptPresetEditorState(state, {
			type: "draft-changed",
			blockId: 5,
			draft: contentDraft("Write warmly."),
		});

		state = adopt(state, recipe(8, [instructionSlot(9, "Voice", "Write plainly.")]));

		expect(state.drafts).toEqual({});
	});

	test("drafts prune when occurrences vanish", () => {
		let state = openState();
		state = adopt(state, recipe(7, [
			instructionSlot(5, "Voice", "Write plainly."),
			identitySlot(6, "assistant"),
		]));
		state = reducePromptPresetEditorState(state, {
			type: "draft-changed",
			blockId: 5,
			draft: contentDraft("Write warmly."),
		});
		state = reducePromptPresetEditorState(state, {
			type: "draft-changed",
			blockId: 6,
			draft: { kind: "role", role: "user" },
		});

		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));

		expect(state.drafts[6]).toBeUndefined();
		expect(state.drafts[5]).toBeDefined();
	});
});

describe("busy, notice and leave transitions", () => {
	test("a library operation clears the previous notice and holds busy until it settles", () => {
		let state = openState();
		state = reducePromptPresetEditorState(state, { type: "notice-changed", notice: "old notice" });

		state = reducePromptPresetEditorState(state, {
			type: "operation-started",
			operation: "busy",
			invalidateReads: true,
			clearNotice: true,
		});
		expect(state.notice).toBeNull();
		expect(state.operation).toBe("busy");

		state = reducePromptPresetEditorState(state, { type: "operation-settled", claim: operationClaim(state) });
		expect(state.operation).toBeNull();
	});

	test("keep editing cancels the pending leave and keeps the drafts", () => {
		let state = openState();
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		const draft = contentDraft("Write warmly.");
		state = reducePromptPresetEditorState(state, { type: "draft-changed", blockId: 5, draft });
		state = reducePromptPresetEditorState(state, { type: "leave-requested", request: { kind: "close" } });

		state = reducePromptPresetEditorState(state, { type: "leave-kept" });

		expect(state.leaveRequest).toBeNull();
		expect(state.drafts[5]).toEqual(draft);
	});

	test("a leave resolves after a successful save", () => {
		let state = openState();
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		const draft = contentDraft("Write warmly.");
		state = reducePromptPresetEditorState(state, { type: "draft-changed", blockId: 5, draft });
		state = reducePromptPresetEditorState(state, {
			type: "leave-requested",
			request: { kind: "select", presetId: 8 },
		});
		state = reducePromptPresetEditorState(state, { type: "operation-started", operation: "leave" });
		const claim = operationClaim(state);

		state = reducePromptPresetEditorState(state, { type: "drafts-submitted", submitted: { 5: draft } });
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write warmly.")]));
		state = reducePromptPresetEditorState(state, { type: "leave-resolved" });
		state = reducePromptPresetEditorState(state, { type: "operation-settled", claim });

		expect(state.leaveRequest).toBeNull();
		expect(state.drafts).toEqual({});
		expect(state.operation).toBeNull();
	});

	test("a failed save retains the drafts and reports the problem", () => {
		let state = openState();
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		const draft = contentDraft("Write warmly.");
		state = reducePromptPresetEditorState(state, { type: "draft-changed", blockId: 5, draft });
		state = reducePromptPresetEditorState(state, { type: "leave-requested", request: { kind: "close" } });
		state = reducePromptPresetEditorState(state, { type: "operation-started", operation: "leave" });

		state = reducePromptPresetEditorState(state, {
			type: "leave-failed",
			problem: "The Prompt Preset change could not be saved.",
		});

		expect(state.drafts[5]).toEqual(draft);
		expect(state.leaveRequest).toBeNull();
		expect(state.problem).toBe("The Prompt Preset change could not be saved.");
	});
});
