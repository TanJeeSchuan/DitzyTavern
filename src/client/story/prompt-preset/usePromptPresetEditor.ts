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
	open,
	onConversationChange,
	onOpenChange,
}: {
	conversation: ConversationSummary | null;
	open: boolean;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	onOpenChange: (open: boolean) => void;
}) {
	const runtime = usePromptPresetEditorRuntime({ conversation, open });
	const library = usePromptPresetLibrary({ runtime, conversation, onConversationChange });
	const recipe = usePromptPresetRecipe({ runtime, conversation });
	const leave = usePromptPresetLeave({
		runtime,
		conversation,
		onOpenChange,
		applySelection: library.applySelection,
		saveDrafts: recipe.saveDrafts,
	});

	return {
		view: runtime.state.view,
		drafts: runtime.state.drafts,
		busy: runtime.state.busy,
		dirtyCount: runtime.dirtyCount,
		notice: runtime.state.notice,
		problem: runtime.state.problem,
		leaveRequest: runtime.state.leaveRequest,
		review: runtime.state.review,
		requestOpenChange: leave.requestOpenChange,
		guardDirtyDismiss: leave.guardDirtyDismiss,
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
