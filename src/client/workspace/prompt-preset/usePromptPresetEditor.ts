import type { ConversationSummary } from "../../conversation";
import { usePromptPresetEditorRuntime } from "./usePromptPresetEditorRuntime";
import { usePromptPresetLibrary } from "./usePromptPresetLibrary";
import { usePromptPresetLeave } from "./usePromptPresetLeave";
import { usePromptPresetRecipe } from "./usePromptPresetRecipe";

/**
 * ==[HUMAN APPROVED]== Owns the Prompt Preset panel by composing focused units over one runtime:
 * the runtime owns the session state and the single operation-settlement owner, the
 * library unit owns the shared list, selection and interchange, the recipe unit owns
 * the block drafts and recipe operations, and the leave unit owns the unsaved-drafts
 * guard. Every flow consults the runtime's ownership rules after an await, so response
 * ordering lives in one place instead of in every handler.
 */
export function usePromptPresetEditor({
	conversation,
	onConversationChange,
	onClose,
}: {
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	onClose: () => void;
}) {
	const runtime = usePromptPresetEditorRuntime({ conversation });
	const library = usePromptPresetLibrary({ runtime, conversation, onConversationChange });
	const recipe = usePromptPresetRecipe({ runtime, conversation });
	const leave = usePromptPresetLeave({
		runtime,
		conversation,
		onClose,
		applySelection: library.applySelection,
		saveDrafts: recipe.saveDrafts,
	});
	const save = async () => {
		const live = runtime.current();
		if (live.view.status !== "ready" || !runtime.dirty) return false;
		const selected = live.view.selected;
		const result = await runtime.runOperation({ supersedesReads: false, ownsConversation: false, clearNotice: false, clearProblem: false }, (claim) => recipe.saveDrafts(selected, claim));
		if (result?.status === "failed") runtime.dispatch({ type: "leave-failed", problem: result.problem });
		return result?.status === "saved";
	};

	return {
		view: runtime.state.view,
		drafts: runtime.state.drafts,
		busy: runtime.state.busy,
		dirtyCount: runtime.dirtyCount,
		save,
		notice: runtime.state.notice,
		problem: runtime.state.problem,
		leaveRequest: runtime.state.leaveRequest,
		review: runtime.state.review,
		requestClose: leave.requestClose,
		selectPreset: library.selectPreset,
		runPresetCommand: library.runPresetCommand,
		exportSelectedPreset: library.exportSelectedPreset,
		importPresetFile: library.importPresetFile,
		commitSillyTavernReview: library.commitSillyTavernReview,
		selectSillyTavernOrder: library.selectSillyTavernOrder,
		cancelSillyTavernReview: library.cancelSillyTavernReview,
		runRecipeOperation: recipe.runRecipeOperation,
		setDraft: recipe.setDraft,
		clearDraft: recipe.clearDraft,
		saveAndLeave: leave.saveAndLeave,
		keepEditing: leave.keepEditing,
		discardAndLeave: leave.discardAndLeave,
	};
}
