import type { ConversationSummary } from "../../conversation";
import type { ConversationPromptPreset } from "../../../shared/contract/prompt-preset";
import type { LeaveRequest, OperationClaim, OperationStartEffects } from "../../prompt-preset-editor-state";
import type { SaveDraftsResult } from "./usePromptPresetRecipe";
import type { PromptPresetEditorRuntime } from "./usePromptPresetEditorRuntime";

interface PromptPresetLeaveUnit {
	requestOpenChange: (next: boolean) => void;
	guardDirtyDismiss: (event: { preventDefault: () => void }) => void;
	saveAndLeave: () => Promise<void>;
	keepEditing: () => void;
	discardAndLeave: () => void;
}

// ==[HUMAN APPROVED]== The save-on-leave operation's declared start effects: it keeps any in-flight
// read current until its own unified refresh cancels it, owns no Conversation race, and clears no
// feedback channel as it starts. The leave handoff is the hook's settle-then-resolve sequencing
// below, not a state flag.
const SAVE_ON_LEAVE_EFFECTS: OperationStartEffects = {
	supersedesReads: false,
	ownsConversation: false,
	clearNotice: false,
	clearProblem: false,
};

// ==[HUMAN APPROVED]== The leave unit: the unsaved-drafts guard every dismissal path shares, and the
// deferred close or selection that only runs after the atomic save settles. Save-on-leave is
// linearized: the batch is submitted, a current refresh is accepted, the save settles, and only
// then does the leave resolve to close or start a selection.
export function usePromptPresetLeave({
	runtime,
	conversation,
	onOpenChange,
	applySelection,
	saveDrafts,
}: {
	runtime: PromptPresetEditorRuntime;
	conversation: ConversationSummary | null;
	onOpenChange: (open: boolean) => void;
	applySelection: (presetId: number) => void;
	saveDrafts: (
		preset: ConversationPromptPreset,
		claim: OperationClaim,
	) => Promise<SaveDraftsResult>;
}): PromptPresetLeaveUnit {
	const { current, dirty, dispatch, runOperation, ownsOperation } = runtime;

	// ==[HUMAN APPROVED]== Completes a resolved leave: the drafts are gone and the deferred action
	// — closing the panel or applying the pending selection — runs. Called only after the save
	// operation has settled, so the runtime gate is released when a selection starts.
	const finishLeave = (request: LeaveRequest): void => {
		dispatch({ type: "leave-resolved" });
		if (request.kind === "close") {
			onOpenChange(false);
		} else {
			applySelection(request.presetId);
		}
	};

	const saveAndLeave = async (): Promise<void> => {
		const live = current();
		const request = live.leaveRequest;
		const currentReady = live.view.status === "ready" ? live.view : null;
		if (conversation === null || currentReady === null || request === null) return;
		// ==[HUMAN APPROVED]== The save operation settles before `runOperation` resolves, so the
		// outcome below is read after the runtime gate is released. Only a still-current
		// successful save resolves the leave; a failed save reports and stays open, a superseded
		// refresh aborts without completing the leave, and reconciliation that left newer dirty
		// drafts keeps the panel open.
		const outcome = await runOperation(SAVE_ON_LEAVE_EFFECTS, async (claim) => {
			const result = await saveDrafts(currentReady.selected, claim);
			if (!ownsOperation(claim)) return { status: "aborted" as const };
			return result;
		});
		if (outcome === undefined) return;
		if (outcome.status === "failed") {
			dispatch({ type: "leave-failed", problem: outcome.problem });
			return;
		}
		if (outcome.status === "saved") {
			finishLeave(request);
			return;
		}
		if (outcome.status === "kept") {
			dispatch({ type: "leave-kept" });
		}
	};

	const keepEditing = (): void => dispatch({ type: "leave-kept" });

	const discardAndLeave = (): void => {
		const request = current().leaveRequest;
		if (request === null) return;
		finishLeave(request);
	};

	const requestOpenChange = (next: boolean): void => {
		if (!next && dirty) {
			dispatch({ type: "leave-requested", request: { kind: "close" } });
			return;
		}
		onOpenChange(next);
	};

	// ==[HUMAN APPROVED]== Escape and outside clicks take the same unsaved-drafts guard as the
	// close button, so a dirty block edit is never silently dropped by any
	// dismissal path.
	const guardDirtyDismiss = (event: { preventDefault: () => void }): void => {
		if (!dirty) return;
		event.preventDefault();
		dispatch({ type: "leave-requested", request: { kind: "close" } });
	};

	return { requestOpenChange, guardDirtyDismiss, saveAndLeave, keepEditing, discardAndLeave };
}
