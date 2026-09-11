import { useEffect, useRef, useState } from "react";
import {
	loadConversationPromptPreset,
	type ConversationSummary,
} from "../../conversation";
import { listPromptPresets } from "../../prompt-preset-library";
import { useAsyncEffect } from "../../lib/use-async";
import {
	createPromptPresetEditorState,
	dirtyDraftSummary,
	operationApplies,
	operationClaim,
	readApplies,
	readClaim,
	reducePromptPresetEditorState,
	type EditorLoadResult,
	type OperationClaim,
	type OperationStartEffects,
	type PresetView,
	type PromptPresetEditorEvent,
	type PromptPresetEditorState,
} from "../../prompt-preset-editor-state";

// ==[HUMAN APPROVED]== The shared owner of the panel's session state and operation settlement: every
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
	loadRecipe: (isCancelled?: () => boolean) => Promise<EditorLoadResult>;
	runOperation: <R>(
		effects: OperationStartEffects,
		body: (claim: OperationClaim) => Promise<R>,
	) => Promise<R | undefined>;
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

	// ==[HUMAN APPROVED]== Unmounting the panel invalidates every in-flight response, callback,
	// download and deferred leave: once the editor is gone no operation may settle or continue,
	// and dispatch becomes a no-op so no state update or deferred action can escape it.
	const alive = useRef(true);
	useEffect(() => () => { alive.current = false; }, []);

	const current = (): PromptPresetEditorState => stateRef.current;

	const dispatch = (event: PromptPresetEditorEvent): void => {
		if (!alive.current) return;
		const next = reducePromptPresetEditorState(stateRef.current, event);
		stateRef.current = next;
		setState(next);
	};

	const ownsOperation = (claim: OperationClaim): boolean =>
		alive.current && operationApplies(stateRef.current, claim);

	// ==[HUMAN APPROVED]== One operation settlement owner: a flow declares its start effects and
	// hands over its body, and this wrapper refuses a second operation while the first is active,
	// runs the body and settles only its own busy state. Because the settle happens synchronously
	// before `runOperation` resolves, a leave that starts its selection after `await runOperation(...)`
	// runs with busy already released.
	const runOperation = async <R>(
		effects: OperationStartEffects,
		body: (claim: OperationClaim) => Promise<R>,
	): Promise<R | undefined> => {
		if (!open || !alive.current || stateRef.current.busy) return undefined;
		dispatch({ type: "operation-started", effects });
		const claim = operationClaim(stateRef.current);
		try {
			return await body(claim);
		} finally {
			if (ownsOperation(claim)) dispatch({ type: "operation-settled", claim });
		}
	};

	// ==[HUMAN APPROVED]== The broad refresh path for initial load, revision refreshes, library
	// commands, imports and selection changes: it fetches the library list and the
	// Conversation-resolved recipe, requires both successes for ready, and classifies a current
	// response under one acceptance rule. An authoritative null recipe takes precedence over a
	// library-list failure; otherwise either request failure is a network outcome that retains the
	// last ready view (or shows unavailable on initial load). Every call cancels the previous read
	// regardless of caller.
	const load = async (isCancelled?: () => boolean): Promise<EditorLoadResult> => {
		if (!open) return "stale";
		if (conversation === null) {
			dispatch({ type: "recipe-unavailable" });
			return "not-found";
		}
		const conversationId = conversation.id;
		dispatch({ type: "read-started" });
		const claim = readClaim(stateRef.current);
		const [presetsResult, selectedResult] = await Promise.allSettled([
			listPromptPresets(),
			loadConversationPromptPreset(conversationId),
		]);
		if (isCancelled?.() || !readApplies(stateRef.current, claim)) return "stale";
		if (selectedResult.status === "fulfilled") {
			const selected = selectedResult.value;
			if (selected === null) {
				// ==[HUMAN APPROVED]== An authoritative null recipe takes precedence over a list failure.
				dispatch({ type: "recipe-unavailable" });
				return "not-found";
			}
			if (presetsResult.status === "fulfilled") {
				dispatch({
					type: "recipe-adopted",
					claim,
					selected,
					presets: presetsResult.value,
				});
				return "ready";
			}
		}
		dispatch({ type: "load-failed" });
		return "network";
	};

	// ==[HUMAN APPROVED]== Recipe mutations reload only the selected Conversation-resolved recipe;
	// the library summary is unchanged by block edits. It keeps the same read claim and stale
	// response handling as the broad refresh, including authoritative absence and last-view
	// preservation on network failure.
	const loadRecipe = async (isCancelled?: () => boolean): Promise<EditorLoadResult> => {
		if (!open) return "stale";
		if (conversation === null) {
			dispatch({ type: "recipe-unavailable" });
			return "not-found";
		}
		const conversationId = conversation.id;
		dispatch({ type: "read-started" });
		const claim = readClaim(stateRef.current);
		const selectedResult = await Promise.allSettled([
			loadConversationPromptPreset(conversationId),
		]);
		if (isCancelled?.() || !readApplies(stateRef.current, claim)) return "stale";
		const selectedResultValue = selectedResult[0];
		if (selectedResultValue?.status === "fulfilled") {
			const selected = selectedResultValue.value;
			if (selected === null) {
				dispatch({ type: "recipe-unavailable" });
				return "not-found";
			}
			dispatch({ type: "recipe-adopted", claim, selected });
			return "ready";
		}
		dispatch({ type: "load-failed" });
		return "network";
	};

	const { view, drafts } = state;
	const ready = view.status === "ready" ? view : null;
	const { dirty, count } = ready === null
		? { dirty: false, count: 0 }
		: dirtyDraftSummary(ready.selected, drafts);
	const dirtyCount = count;

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

	return { state, current, ready, dirty, dirtyCount, dispatch, load, loadRecipe, runOperation, ownsOperation };
}
