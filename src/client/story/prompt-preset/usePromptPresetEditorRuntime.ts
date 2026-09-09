import { useRef, useState } from "react";
import {
	loadConversationPromptPreset,
	type ConversationSummary,
} from "../../conversation";
import { listPromptPresets } from "../../prompt-preset-library";
import { useAsyncEffect } from "../../lib/use-async";
import {
	createPromptPresetEditorState,
	dirtyDraftCount,
	draftIsDirty,
	operationApplies,
	operationClaim,
	readApplies,
	readClaim,
	reducePromptPresetEditorState,
	type EditorLoadResult,
	type EditorOperationKind,
	type OperationClaim,
	type PresetView,
	type PromptPresetEditorEvent,
	type PromptPresetEditorState,
} from "../../prompt-preset-editor-state";

// ==[HUMAN APPROVED]== The shared owner of the popup's session state and operation settlement: every
// focused unit starts work through `runOperation` and checks ownership through `ownsOperation`, so
// no flow assembles its own epoch handling and one settle rule holds busy for every mutation.
export interface PromptPresetEditorRuntime {
	state: PromptPresetEditorState;
	current: () => PromptPresetEditorState;
	ready: Extract<PresetView, { status: "ready" }> | null;
	dirty: boolean;
	dirtyCount: number;
	dispatch: (event: PromptPresetEditorEvent) => void;
	load: (isCancelled?: () => boolean) => Promise<EditorLoadResult>;
	runOperation: (
		kind: EditorOperationKind,
		body: (claim: OperationClaim) => Promise<void>,
	) => Promise<void>;
	ownsOperation: (claim: OperationClaim) => boolean;
}

export function usePromptPresetEditorRuntime({
	conversation,
	open,
}: {
	conversation: ConversationSummary | null;
	open: boolean;
}): PromptPresetEditorRuntime {
	const sessionKey = open ? `open:${conversation?.id ?? "none"}` : "closed";
	const [state, setState] = useState(() =>
		createPromptPresetEditorState(sessionKey, conversation?.revision ?? null));
	const stateRef = useRef(state);

	const current = (): PromptPresetEditorState => stateRef.current;

	const dispatch = (event: PromptPresetEditorEvent): void => {
		const next = reducePromptPresetEditorState(stateRef.current, event);
		stateRef.current = next;
		setState(next);
	};

	const ownsOperation = (claim: OperationClaim): boolean =>
		operationApplies(stateRef.current, claim);

	// ==[HUMAN APPROVED]== One operation settlement owner: a flow names its kind and hands over its
	// body, and this wrapper claims the epoch, runs the body and settles only its own busy state.
	const runOperation = async (
		kind: EditorOperationKind,
		body: (claim: OperationClaim) => Promise<void>,
	): Promise<void> => {
		dispatch({ type: "operation-started", kind });
		const claim = operationClaim(stateRef.current);
		try {
			await body(claim);
		} finally {
			if (ownsOperation(claim)) dispatch({ type: "operation-settled", claim });
		}
	};

	const load = async (isCancelled?: () => boolean): Promise<EditorLoadResult> => {
		if (!open) return "stale";
		if (conversation === null) {
			dispatch({ type: "recipe-unavailable" });
			return "not-found";
		}
		const conversationId = conversation.id;
		dispatch({ type: "read-started" });
		const claim = readClaim(stateRef.current);
		try {
			const [presets, selected] = await Promise.all([
				listPromptPresets(),
				loadConversationPromptPreset(conversationId),
			]);
			if (isCancelled?.() || !readApplies(stateRef.current, claim)) return "stale";
			if (selected === null) {
				dispatch({ type: "recipe-unavailable" });
				return "not-found";
			}
			dispatch({ type: "recipe-adopted", claim, selected, presets });
			return "ready";
		} catch {
			if (!isCancelled?.() && readApplies(stateRef.current, claim)) {
				dispatch({ type: "load-failed" });
			}
			return "network";
		}
	};

	const { view, drafts } = state;
	const ready = view.status === "ready" ? view : null;
	const dirty = ready !== null && ready.selected.slots.some((slot) => {
		const draft = drafts[slot.id];
		return draft !== undefined && draftIsDirty(slot, draft);
	});
	const dirtyCount = ready === null ? 0 : dirtyDraftCount(ready.selected, drafts);

	useAsyncEffect((isCancelled) => {
		const currentState = stateRef.current;
		if (currentState.session.key !== sessionKey) {
			// ==[HUMAN APPROVED]== Every open or Chat transition starts clean; a same-session revision
			// refresh keeps drafts.
			dispatch({
				type: "session-changed",
				sessionKey,
				conversationRevision: conversation?.revision ?? null,
			});
		} else if (open && currentState.session.knownRevision !== (conversation?.revision ?? null)) {
			dispatch({
				type: "conversation-revision-changed",
				conversationRevision: conversation?.revision ?? null,
			});
		}
		if (!open) return;
		void load(isCancelled);
	}, [open, conversation?.id, conversation?.revision]);

	return { state, current, ready, dirty, dirtyCount, dispatch, load, runOperation, ownsOperation };
}
