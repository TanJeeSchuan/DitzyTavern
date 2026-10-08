import {
	savePromptPresetBlockPatches,
	type PromptPresetOperationOutcome,
} from "../../prompt-preset-library";
import type { ConversationPromptPreset } from "../../../shared/contract/prompt-preset";
import {
	dirtyBlockPatches,
	dirtyDraftSummary,
	type BlockDraft,
	type OperationClaim,
	type OperationStartEffects,
} from "../../prompt-preset-editor-state";
import type { ConversationSummary } from "../../conversation";
import type { PromptPresetEditorRuntime } from "./usePromptPresetEditorRuntime";

interface PromptPresetRecipeUnit {
	runRecipeOperation: (run: () => Promise<PromptPresetOperationOutcome>) => Promise<void>;
	setDraft: (blockId: number, draft: BlockDraft) => void;
	setEnabled: (blockId: number, enabled: boolean) => void;
	clearDraft: (blockId: number) => void;
	saveDrafts: (
		preset: ConversationPromptPreset,
		claim: OperationClaim,
	) => Promise<SaveDraftsResult>;
}

// @approved
//  The recipe operation's declared start effects: it keeps any in-flight read
// current (a failed or superseded recipe operation leaves the last view intact), owns no
// Conversation race, and clears the problem channel as it starts so its own outcome owns the copy.
const RECIPE_OPERATION_EFFECTS: OperationStartEffects = {
	supersedesReads: false,
	ownsConversation: false,
	clearNotice: false,
	clearProblem: true,
};

const promptPresetOperationProblem = (
	outcome: Exclude<PromptPresetOperationOutcome, { outcome: "available" }>,
	fallback: string,
): string => outcome.outcome === "invalid"
	? outcome.reason
	: outcome.outcome === "not-found"
		? "The selected preset no longer exists."
		: fallback;

// @approved
//  The save-on-leave result a leave resolution acts on: a successful save whose
// refresh accepted may resolve the leave, `kept` stays open with newer dirty drafts retained,
// `failed` reports a problem while retaining drafts, and `aborted` makes no state or feedback
// change because the save-on-leave's refresh was superseded.
export type SaveDraftsResult =
	| { status: "saved" }
	| { status: "kept" }
	| { status: "failed"; problem: string }
	| { status: "aborted" };

// @approved
//  The recipe unit: immediate ordering and an atomic draft save batch.
// It shares the runtime's settlement owner and refresh
// ownership, so its flows cannot diverge from the library unit's response rules.
export function usePromptPresetRecipe({
	runtime,
	conversation,
}: {
	runtime: PromptPresetEditorRuntime;
	conversation: ConversationSummary | null;
}): PromptPresetRecipeUnit {
	const { current, dispatch, loadRecipe, runOperation, ownsOperation } = runtime;

	// @approved
	//  One recipe operation execution: pending and problem state live here, and
	// the applied response reloads only the selected Conversation-resolved recipe. An
	// authoritative null recipe stays silent
	// here (the view is already unavailable); network failure reports the recipe reload problem.
	const runRecipeOperation = async (run: () => Promise<PromptPresetOperationOutcome>): Promise<void> => {
		if (conversation === null) return;
		await runOperation(RECIPE_OPERATION_EFFECTS, async (claim) => {
			const outcome = await run();
			if (!ownsOperation(claim)) return;
			if (outcome.outcome !== "available") {
				dispatch({
					type: "problem-changed",
					problem: promptPresetOperationProblem(outcome, "The Prompt Preset change could not be reached."),
				});
				return;
			}
			const refresh = await loadRecipe();
			if (!ownsOperation(claim)) return;
			if (refresh === "network") {
				dispatch({
					type: "problem-changed",
					problem: "The Prompt Preset change could not be reloaded.",
				});
			}
		});
	};

	const setDraft = (blockId: number, draft: BlockDraft): void =>
		dispatch({ type: "draft-changed", blockId, draft });
	const setEnabled = (blockId: number, enabled: boolean): void =>
		dispatch({ type: "enabled-changed", blockId, enabled });

	const clearDraft = (blockId: number): void => dispatch({ type: "draft-cleared", blockId });

	// @approved
	//  Save-on-leave submits every dirty occurrence in one typed domain command,
	// then reloads only the selected Conversation-resolved recipe. The save's own refresh (not a
	// pre-save read) accepts the fresh recipe and retires exactly the submitted draft versions; the
	// local drafts remain available if the save is rejected or either request fails, and a superseded
	// refresh aborts without completing the leave.
	const saveDrafts = async (
		preset: ConversationPromptPreset,
		claim: OperationClaim,
	): Promise<SaveDraftsResult> => {
		if (current().session.draftPresetId !== preset.id) {
			return { status: "failed", problem: "The selected Prompt Preset is no longer current." };
		}
		const { patches, submitted } = dirtyBlockPatches(preset, current().drafts);
		const outcome = await savePromptPresetBlockPatches(preset.id, patches);
		if (!ownsOperation(claim)) return { status: "aborted" };
		if (outcome.outcome !== "available") {
			return {
				status: "failed",
				problem: promptPresetOperationProblem(outcome, "The Prompt Preset change could not be saved."),
			};
		}
		dispatch({ type: "drafts-submitted", submitted });
		const refresh = await loadRecipe();
		if (!ownsOperation(claim)) return { status: "aborted" };
		if (refresh === "network") {
			return { status: "failed", problem: "The saved Prompt Preset could not be reloaded." };
		}
		if (refresh === "not-found") {
			return { status: "failed", problem: "The selected preset could not be reloaded." };
		}
		if (refresh === "stale") return { status: "aborted" };
		const live = current();
		const freshReady = live.view.status === "ready" ? live.view : null;
		if (freshReady !== null && dirtyDraftSummary(freshReady.selected, live.drafts).count > 0) {
			// @approved
			//  The save settled but reconciliation left newer dirty drafts: retain
			// them and keep the panel open instead of clearing them through leave resolution.
			return { status: "kept" };
		}
		return { status: "saved" };
	};

	return { runRecipeOperation, setDraft, setEnabled, clearDraft, saveDrafts };
}
