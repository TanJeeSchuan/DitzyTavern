import {
	loadConversationPromptPreset,
	type ConversationSummary,
} from "../../conversation";
import {
	savePromptPresetBlockPatches,
	type PromptPresetOperationOutcome,
} from "../../prompt-preset-library";
import type { ConversationPromptPreset } from "../../../shared/contract/prompt-preset";
import {
	dirtyBlockPatches,
	readClaim,
	type BlockDraft,
	type OperationClaim,
} from "../../prompt-preset-editor-state";
import type { PromptPresetEditorRuntime } from "./usePromptPresetEditorRuntime";

export interface PromptPresetRecipeUnit {
	runRecipeOperation: (
		run: () => Promise<PromptPresetOperationOutcome>,
		submitted?: { blockId: number; draft: BlockDraft },
	) => Promise<void>;
	setDraft: (blockId: number, draft: BlockDraft) => void;
	clearDraft: (blockId: number) => void;
	saveDrafts: (
		preset: ConversationPromptPreset,
		claim: OperationClaim,
		conversationId: number,
	) => Promise<string | null>;
}

// ==[HUMAN APPROVED]== The recipe unit: immediate ordering and enablement, per-block authored saves
// and the atomic save-on-leave batch. It shares the runtime's settlement owner and one
// selected-recipe reload epilogue.
export function usePromptPresetRecipe({
	runtime,
	conversation,
}: {
	runtime: PromptPresetEditorRuntime;
	conversation: ConversationSummary | null;
}): PromptPresetRecipeUnit {
	const { state, current, dispatch, runOperation, ownsOperation } = runtime;
	const { busy } = state;

	// ==[HUMAN APPROVED]== The shared mutation reload epilogue: bump the read epoch, read the
	// fresh selected recipe and adopt it through the shared acceptance rule. A
	// vanished recipe ends in the unavailable view; the caller reports the
	// returned failure through its own feedback channel, so wordings stay per-flow.
	const reloadSelectedRecipe = async (
		claim: OperationClaim,
		conversationId: number,
		failure: { network: string; missing: string | null },
	): Promise<string | null> => {
		dispatch({ type: "read-started" });
		const read = readClaim(current());
		let fresh: ConversationPromptPreset | null;
		try {
			fresh = await loadConversationPromptPreset(conversationId);
		} catch {
			return ownsOperation(claim) ? failure.network : null;
		}
		if (!ownsOperation(claim)) return null;
		if (fresh === null) {
			dispatch({ type: "recipe-unavailable" });
			return failure.missing;
		}
		dispatch({ type: "recipe-adopted", claim: read, selected: fresh });
		return null;
	};

	// ==[HUMAN APPROVED]== One recipe operation execution: pending and problem state live here, and
	// the applied response's fresh recipe read refreshes the selected recipe
	// through the shared acceptance rule while leaving the library list and
	// every other saved change untouched. When the operation submitted one
	// occurrence's draft, that exact version is retired on acceptance so saved
	// content never resurfaces as an unsaved edit.
	const runRecipeOperation = async (
		run: () => Promise<PromptPresetOperationOutcome>,
		submitted?: { blockId: number; draft: BlockDraft },
	): Promise<void> => {
		if (conversation === null) return;
		if (busy) return;
		const conversationId = conversation.id;
		await runOperation("recipe-operation", async (claim) => {
			const outcome = await run();
			if (!ownsOperation(claim)) return;
			if (outcome.status !== "applied") {
				dispatch({
					type: "problem-changed",
					problem: outcome.status === "invalid"
						? outcome.reason
						: outcome.status === "not-found"
							? "The selected preset no longer exists."
							: "The Prompt Preset change could not be reached.",
				});
				return;
			}
			if (submitted !== undefined) {
				dispatch({ type: "drafts-submitted", submitted: { [submitted.blockId]: submitted.draft } });
			}
			const failure = await reloadSelectedRecipe(claim, conversationId, {
				network: "The Prompt Preset change could not be reloaded.",
				missing: null,
			});
			if (failure !== null && ownsOperation(claim)) {
				dispatch({ type: "problem-changed", problem: failure });
			}
		});
	};

	const setDraft = (blockId: number, draft: BlockDraft): void =>
		dispatch({ type: "draft-changed", blockId, draft });

	const clearDraft = (blockId: number): void => dispatch({ type: "draft-cleared", blockId });

	// ==[HUMAN APPROVED]== Save-on-leave submits every dirty occurrence in one typed domain
	// command. The authoritative recipe is read again before the leave completes
	// and adopted through the shared acceptance rule, retiring exactly the
	// submitted draft versions, while the local drafts remain available if
	// either request fails.
	const saveDrafts = async (
		preset: ConversationPromptPreset,
		claim: OperationClaim,
		conversationId: number,
	): Promise<string | null> => {
		if (current().session.draftPresetId !== preset.id) {
			return "The selected Prompt Preset is no longer current.";
		}
		dispatch({ type: "read-started" });
		const { patches, submitted } = dirtyBlockPatches(preset, current().drafts);
		const outcome = await savePromptPresetBlockPatches(preset.id, patches);
		if (!ownsOperation(claim)) return null;
		if (outcome.status !== "applied") {
			return outcome.status === "invalid"
				? outcome.reason
				: outcome.status === "not-found"
					? "The selected preset no longer exists."
					: "The Prompt Preset change could not be saved.";
		}
		dispatch({ type: "drafts-submitted", submitted });
		return reloadSelectedRecipe(claim, conversationId, {
			network: "The saved Prompt Preset could not be reloaded.",
			missing: "The selected preset could not be reloaded.",
		});
	};

	return { runRecipeOperation, setDraft, clearDraft, saveDrafts };
}
