import { useEffect, useRef, useState } from "react";
import {
	loadConversationPromptPreset,
	type ConversationSummary,
} from "../../conversation";
import { listPromptPresets } from "../../prompt-preset-library";
import type { ConversationPromptPreset } from "../../../shared/contract/prompt-preset";
import { useAsyncEffect } from "../../lib/use-async";
import {
	createPromptPresetEditorState,
	createPromptPresetEditorOperationRunner,
	dirtyDraftSummary,
	operationApplies,
	readApplies,
	readClaim,
	reducePromptPresetEditorState,
	type EditorLoadResult,
	type OperationClaim,
	type OperationStartEffects,
	type ReadyPresetView,
	type ReadClaim,
	type PromptPresetEditorEvent,
	type PromptPresetEditorState,
} from "../../prompt-preset-editor-state";

// @approved
//  The shared owner of the panel's session state and operation settlement: every
// focused unit starts work through `runOperation` and checks ownership through `ownsOperation`, so
// no flow assembles its own epoch handling and one settle rule holds busy for every mutation.
export interface PromptPresetEditorRuntime {
	state: PromptPresetEditorState;
	current: () => PromptPresetEditorState;
	ready: ReadyPresetView | null;
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
}: {
	conversation: ConversationSummary | null;
}): PromptPresetEditorRuntime {
	const sessionKey = `conversation:${conversation?.id ?? "none"}`;
	const [state, setState] = useState(() =>
		createPromptPresetEditorState(sessionKey, conversation?.revision ?? null));
	const stateRef = useRef(state);

	// @approved
	//  Unmounting the panel invalidates every in-flight response, callback,
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

	// @approved
	//  One operation settlement owner: a flow declares its start effects and
	// hands over its body, and this wrapper refuses a second operation while the first is active,
	// runs the body and settles only its own busy state. Because the settle happens synchronously
	// before `runOperation` resolves, a leave that starts its selection after `await runOperation(...)`
	// runs with busy already released.
	const runOperation = createPromptPresetEditorOperationRunner({
		current,
		dispatch,
		canStart: () => alive.current && !stateRef.current.busy,
		ownsOperation,
	});

	type SelectedRecipeRead =
		| {
				status: "ready";
				claim: ReadClaim;
				selected: ConversationPromptPreset;
			}
		| { status: Exclude<EditorLoadResult, "ready"> };

	const readSelectedRecipe = async (
		isCancelled?: () => boolean,
	): Promise<SelectedRecipeRead> => {
		if (conversation === null) {
			dispatch({ type: "recipe-unavailable" });
			return { status: "not-found" };
		}
		dispatch({ type: "read-started" });
		const claim = readClaim(stateRef.current);
		try {
			const selected = await loadConversationPromptPreset(conversation.id);
			if (isCancelled?.() || !readApplies(stateRef.current, claim)) return { status: "stale" };
			if (selected === null) {
				dispatch({ type: "recipe-unavailable" });
				return { status: "not-found" };
			}
			return { status: "ready", claim, selected };
		} catch {
			if (isCancelled?.() || !readApplies(stateRef.current, claim)) return { status: "stale" };
			dispatch({ type: "load-failed" });
			return { status: "network" };
		}
	};

	// @approved
	//  The broad refresh path for initial load, revision refreshes, library
	// commands, imports and selection changes: it fetches the library list and the
	// Conversation-resolved recipe, requires both successes for ready, and classifies a current
	// response under one acceptance rule. An authoritative null recipe takes precedence over a
	// library-list failure; otherwise either request failure is a network outcome that retains the
	// last ready view (or shows unavailable on initial load). Every call cancels the previous read
	// regardless of caller.
	const load = async (isCancelled?: () => boolean): Promise<EditorLoadResult> => {
		const [presetsResult, selectedRead] = await Promise.all([
			listPromptPresets().then(
				(presets) => ({ status: "ready" as const, presets }),
				() => ({ status: "network" as const }),
			),
			readSelectedRecipe(isCancelled),
		]);
		if (selectedRead.status !== "ready") return selectedRead.status;
		if (isCancelled?.() || !readApplies(stateRef.current, selectedRead.claim)) return "stale";
		if (presetsResult.status === "ready") {
			dispatch({
				type: "recipe-adopted",
				claim: selectedRead.claim,
				selected: selectedRead.selected,
				presets: presetsResult.presets,
			});
			return "ready";
		}
		dispatch({ type: "load-failed" });
		return "network";
	};

	// @approved
	//  Recipe mutations reload only the selected Conversation-resolved recipe;
	// the library summary is unchanged by block edits. It keeps the same read claim and stale
	// response handling as the broad refresh, including authoritative absence and last-view
	// preservation on network failure.
	const loadRecipe = async (isCancelled?: () => boolean): Promise<EditorLoadResult> => {
		const selectedRead = await readSelectedRecipe(isCancelled);
		if (selectedRead.status !== "ready") return selectedRead.status;
		dispatch({
			type: "recipe-adopted",
			claim: selectedRead.claim,
			selected: selectedRead.selected,
		});
		return "ready";
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
			// @approved
			//  Every Chat transition starts clean; a same-session revision refresh
			// keeps drafts.
			dispatch({
				type: "session-changed",
				sessionKey,
				conversationRevision: conversation?.revision ?? null,
			});
		} else if (currentState.session.knownRevision !== (conversation?.revision ?? null)) {
			dispatch({
				type: "conversation-revision-changed",
				conversationRevision: conversation?.revision ?? null,
			});
		}
		void load(isCancelled);
	}, [conversation?.id, conversation?.revision]);

	return { state, current, ready, dirty, dirtyCount, dispatch, load, loadRecipe, runOperation, ownsOperation };
}
