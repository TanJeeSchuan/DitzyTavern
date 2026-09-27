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
	dirtyBlockPatches,
	dirtyDraftSummary,
	draftIsDirty,
	draftToPatch,
	operationApplies,
	operationClaim,
	readApplies,
	readClaim,
	reducePromptPresetEditorState,
	type BlockDraft,
	type OperationStartEffects,
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

const libraryEffects: OperationStartEffects = {
	supersedesReads: true,
	ownsConversation: false,
	clearNotice: true,
	clearProblem: false,
};
const selectionEffects: OperationStartEffects = {
	supersedesReads: true,
	ownsConversation: true,
	clearNotice: false,
	clearProblem: false,
};
const saveOnLeaveEffects: OperationStartEffects = {
	supersedesReads: false,
	ownsConversation: false,
	clearNotice: false,
	clearProblem: false,
};

const openState = (): PromptPresetEditorState =>
	createPromptPresetEditorState("open:1", 3);

const adopt = (
	state: PromptPresetEditorState,
	selected: ConversationPromptPreset,
): PromptPresetEditorState =>
	reducePromptPresetEditorState(state, { type: "recipe-adopted", claim: readClaim(state), selected });

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

	test("enablement drafts save alone or with authored fields and count once per block", () => {
		const preset = recipe(7, [historySlot(9), instructionSlot(5, "Voice", "Write plainly.")]);
		const drafts = {
			9: { kind: "enabled", enabled: false },
			5: { kind: "content", name: "Voice", content: "Write warmly.", role: "system", enabled: false },
		} satisfies Record<number, BlockDraft>;
		expect(dirtyBlockPatches(preset, drafts).patches).toEqual([
			{ occurrenceId: 9, type: "enabled", enabled: false },
			{ occurrenceId: 5, type: "content", name: "Voice", content: "Write warmly.", role: "system", enabled: false },
		]);
		expect(dirtyDraftSummary(preset, drafts)).toEqual({ dirty: true, count: 2 });
		expect(draftToPatch(historySlot(9), { kind: "enabled", enabled: true })).toBeNull();
	});

	test("a wrong-kind or history draft produces no patch and is never dirty", () => {
		expect(draftToPatch(identitySlot(6, "assistant"), contentDraft("Write warmly."))).toBeNull();
		expect(draftToPatch(instructionSlot(5, "Voice", "Write plainly."), roleDraft("user"))).toBeNull();
		expect(draftToPatch(historySlot(9), roleDraft("user"))).toBeNull();
		expect(draftToPatch(historySlot(9), contentDraft("Write warmly."))).toBeNull();
		expect(draftIsDirty(historySlot(9), roleDraft("user"))).toBe(false);
	});

	test("dirty count and flag are one pass over the dirty occurrences", () => {
		const preset = recipe(7, [
			instructionSlot(5, "Voice", "Write plainly."),
			identitySlot(6, "assistant"),
			identitySlot(8, "system"),
		]);
		const drafts = {
			5: contentDraft("Write warmly."),
			8: roleDraft("system"), // clean — matches its slot role
		};
		expect(dirtyDraftSummary(preset, drafts)).toEqual({ dirty: true, count: 1 });
		expect(dirtyDraftSummary(preset, {})).toEqual({ dirty: false, count: 0 });
	});

	test("the save-on-leave batch and the dirty count share the same rule", () => {
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
		expect(dirtyDraftSummary(preset, drafts).count).toBe(2);
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
		state = reducePromptPresetEditorState(state, { type: "operation-started", effects: selectionEffects });
		const claim = conversationOperationClaim(state);

		state = reducePromptPresetEditorState(state, {
			type: "conversation-revision-changed",
			conversationRevision: 4,
		});

		expect(conversationOperationApplies(state, claim)).toBe(false);
	});

	test("a newer Conversation snapshot leaves an unrelated library operation current", () => {
		let state = openState();
		state = reducePromptPresetEditorState(state, { type: "operation-started", effects: libraryEffects });
		const claim = operationClaim(state);

		state = reducePromptPresetEditorState(state, {
			type: "conversation-revision-changed",
			conversationRevision: 4,
		});

		expect(operationApplies(state, claim)).toBe(true);
		state = reducePromptPresetEditorState(state, { type: "operation-settled", claim });
		expect(state.busy).toBe(false);
	});
});

describe("draft reconciliation", () => {
	test("a toggle preserves an existing text draft and retires after the saved recipe reloads", () => {
		let state = adopt(openState(), recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		state = reducePromptPresetEditorState(state, { type: "draft-changed", blockId: 5, draft: contentDraft("Write warmly.") });
		state = reducePromptPresetEditorState(state, { type: "enabled-changed", blockId: 5, enabled: false });
		const submitted = state.drafts[5];
		expect(dirtyBlockPatches(recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]), state.drafts).patches)
			.toEqual([{ occurrenceId: 5, type: "content", name: "Voice", content: "Write warmly.", role: "system", enabled: false }]);
		state = reducePromptPresetEditorState(state, { type: "drafts-submitted", submitted: { 5: submitted } });
		state = adopt(state, recipe(7, [{ ...instructionSlot(5, "Voice", "Write warmly."), enabled: false }]));
		expect(state.drafts[5]).toBeUndefined();
	});

	test("a newer toggle survives retirement of an older submitted version", () => {
		let state = adopt(openState(), recipe(7, [historySlot(9)]));
		state = reducePromptPresetEditorState(state, { type: "enabled-changed", blockId: 9, enabled: false });
		state = reducePromptPresetEditorState(state, { type: "drafts-submitted", submitted: { 9: state.drafts[9] } });
		state = reducePromptPresetEditorState(state, { type: "enabled-changed", blockId: 9, enabled: true });
		state = adopt(state, recipe(7, [{ ...historySlot(9), enabled: false }]));
		expect(state.drafts[9]).toEqual({ kind: "enabled", enabled: true });
		if (state.view.status !== "ready") throw new Error("The preset was not reloaded.");
		expect(dirtyDraftSummary(state.view.selected, state.drafts).dirty).toBe(true);
	});

	test("a submitted draft retires only when the fresh recipe reflects it and it still matches", () => {
		let state = openState();
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		const submitted = contentDraft("Write warmly.");
		state = reducePromptPresetEditorState(state, { type: "draft-changed", blockId: 5, draft: submitted });
		state = reducePromptPresetEditorState(state, { type: "drafts-submitted", submitted: { 5: submitted } });

		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write warmly.")]));

		expect(state.drafts[5]).toBeUndefined();
	});

	test("a read that predates the save cannot retire the submitted draft", () => {
		let state = openState();
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		const submitted = contentDraft("Write warmly.");
		state = reducePromptPresetEditorState(state, { type: "draft-changed", blockId: 5, draft: submitted });
		state = reducePromptPresetEditorState(state, { type: "drafts-submitted", submitted: { 5: submitted } });

		// The old recipe does not reflect the submitted save, so the draft survives.
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));

		expect(state.drafts[5]).toEqual(submitted);
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
			draft: roleDraft("user"),
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

		state = reducePromptPresetEditorState(state, { type: "operation-started", effects: libraryEffects });
		expect(state.notice).toBeNull();
		expect(state.busy).toBe(true);

		state = reducePromptPresetEditorState(state, { type: "operation-settled", claim: operationClaim(state) });
		expect(state.busy).toBe(false);
	});

	test("a recipe operation clears the previous problem but leaves the notice", () => {
		const recipeEffects: OperationStartEffects = {
			supersedesReads: false,
			ownsConversation: false,
			clearNotice: false,
			clearProblem: true,
		};
		let state = openState();
		state = reducePromptPresetEditorState(state, { type: "notice-changed", notice: "keep" });
		state = reducePromptPresetEditorState(state, { type: "problem-changed", problem: "old problem" });

		state = reducePromptPresetEditorState(state, { type: "operation-started", effects: recipeEffects });
		expect(state.problem).toBeNull();
		expect(state.notice).toBe("keep");
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
		state = reducePromptPresetEditorState(state, { type: "operation-started", effects: saveOnLeaveEffects });
		const claim = operationClaim(state);

		state = reducePromptPresetEditorState(state, { type: "drafts-submitted", submitted: { 5: draft } });
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write warmly.")]));
		state = reducePromptPresetEditorState(state, { type: "leave-resolved" });
		state = reducePromptPresetEditorState(state, { type: "operation-settled", claim });

		expect(state.leaveRequest).toBeNull();
		expect(state.drafts).toEqual({});
		expect(state.busy).toBe(false);
	});

	test("replacing the popup session clears a pending leave and its drafts", () => {
		let state = openState();
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		state = reducePromptPresetEditorState(state, {
			type: "draft-changed",
			blockId: 5,
			draft: contentDraft("Write warmly."),
		});
		state = reducePromptPresetEditorState(state, { type: "leave-requested", request: { kind: "close" } });

		state = reducePromptPresetEditorState(state, {
			type: "session-changed",
			sessionKey: "open:2",
			conversationRevision: 4,
		});

		expect(state.leaveRequest).toBeNull();
		expect(state.drafts).toEqual({});
		expect(state.busy).toBe(false);
	});

	test("a failed save retains the drafts and reports the problem", () => {
		let state = openState();
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		const draft = contentDraft("Write warmly.");
		state = reducePromptPresetEditorState(state, { type: "draft-changed", blockId: 5, draft });
		state = reducePromptPresetEditorState(state, { type: "leave-requested", request: { kind: "close" } });
		state = reducePromptPresetEditorState(state, { type: "operation-started", effects: saveOnLeaveEffects });

		state = reducePromptPresetEditorState(state, {
			type: "leave-failed",
			problem: "The Prompt Preset change could not be saved.",
		});

		expect(state.drafts[5]).toEqual(draft);
		expect(state.leaveRequest).toBeNull();
		expect(state.problem).toBe("The Prompt Preset change could not be saved.");
	});
});

describe("refresh outcomes", () => {
	test("an authoritative null recipe clears drafts and pending retirement and shows unavailable", () => {
		let state = openState();
		state = adopt(state, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		const draft = contentDraft("Write warmly.");
		state = reducePromptPresetEditorState(state, { type: "draft-changed", blockId: 5, draft });
		state = reducePromptPresetEditorState(state, { type: "drafts-submitted", submitted: { 5: draft } });

		state = reducePromptPresetEditorState(state, { type: "recipe-unavailable" });

		expect(state.view).toEqual({ status: "unavailable" });
		expect(state.drafts).toEqual({});
		expect(state.session.pendingRetire).toBeNull();
	});

	test("a network failure retains the last ready view and a failed initial load becomes unavailable", () => {
		let readyState = openState();
		readyState = adopt(readyState, recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]));
		readyState = reducePromptPresetEditorState(readyState, { type: "load-failed" });
		expect(readyState.view).toEqual({
			status: "ready",
			presets: [],
			selected: recipe(7, [instructionSlot(5, "Voice", "Write plainly.")]),
		});

		const loadingState = reducePromptPresetEditorState(openState(), { type: "load-failed" });
		expect(loadingState.view).toEqual({ status: "unavailable" });
	});
});
