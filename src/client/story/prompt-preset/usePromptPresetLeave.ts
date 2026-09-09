import type { ConversationSummary } from "../../conversation";
import type { ConversationPromptPreset } from "../../../shared/contract/prompt-preset";
import type { LeaveRequest, OperationClaim } from "../../prompt-preset-editor-state";
import type { PromptPresetEditorRuntime } from "./usePromptPresetEditorRuntime";

export interface PromptPresetLeaveUnit {
	requestOpenChange: (next: boolean) => void;
	guardDirtyDismiss: (event: { preventDefault: () => void }) => void;
	saveAndLeave: () => Promise<void>;
	keepEditing: () => void;
	discardAndLeave: () => void;
}

// ==[HUMAN APPROVED]== The leave unit: the unsaved-drafts guard every dismissal path shares, and the
// deferred close or selection that only runs after the atomic save settles.
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
	applySelection: (presetId: number, resolvingLeave?: boolean) => void;
	saveDrafts: (
		preset: ConversationPromptPreset,
		claim: OperationClaim,
		conversationId: number,
	) => Promise<string | null>;
}): PromptPresetLeaveUnit {
	const { state, current, dirty, dispatch, runOperation, ownsOperation } = runtime;
	const { leaveRequest } = state;

	// ==[HUMAN APPROVED]== Completes a resolved leave: the drafts are gone and the deferred action
	// — closing the popup or applying the pending selection — runs.
	const finishLeave = (request: LeaveRequest): void => {
		dispatch({ type: "leave-resolved" });
		if (request.kind === "close") {
			onOpenChange(false);
		} else {
			applySelection(request.presetId, true);
		}
	};

	const saveAndLeave = async (): Promise<void> => {
		const live = current();
		const request = live.leaveRequest;
		const currentReady = live.view.status === "ready" ? live.view : null;
		if (live.busy || conversation === null || currentReady === null || request === null) return;
		const conversationId = conversation.id;
		await runOperation("save-on-leave", async (claim) => {
			const failure = await saveDrafts(currentReady.selected, claim, conversationId);
			if (!ownsOperation(claim)) return;
			if (failure !== null) {
				dispatch({ type: "leave-failed", problem: failure });
				return;
			}
			finishLeave(request);
		});
	};

	const keepEditing = (): void => dispatch({ type: "leave-kept" });

	const discardAndLeave = (): void => {
		const request = leaveRequest;
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
