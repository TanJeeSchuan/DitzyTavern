import { queryOptions, skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { flushSync } from "react-dom";
import { useEffect, useEffectEvent, useRef, useState } from "react";
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
	const client = useQueryClient();
	const recipeOptions = queryOptions({
		queryKey: ["prompt-preset-editor", conversation?.id ?? null, conversation?.revision ?? null] as const,
		staleTime: Infinity,
		refetchOnReconnect: false,
		queryFn: conversation === null ? skipToken : async ({ signal }: { signal: AbortSignal }) => {
			await Promise.resolve();
			signal.throwIfAborted();
			return loadConversationPromptPreset(conversation.id, signal);
		},
	});
	const libraryOptions = queryOptions({
		queryKey: ["prompt-presets"] as const,
		staleTime: Infinity,
		queryFn: async ({ signal }: { signal: AbortSignal }) => {
			await Promise.resolve();
			signal.throwIfAborted();
			return listPromptPresets(signal);
		},
	});
	const recipeQuery = useQuery(recipeOptions);
	const libraryQuery = useQuery(libraryOptions);
	const sessionKey = `conversation:${conversation?.id ?? "none"}`;
	const [state, setState] = useState(() =>
		createPromptPresetEditorState(sessionKey, conversation?.revision ?? null));

	// @approved
	//  Unmounting the panel invalidates every in-flight response, callback,
	// download and deferred leave: once the editor is gone no operation may settle or continue,
	// and dispatch becomes a no-op so no state update or deferred action can escape it.
	const alive = useRef(true);
	useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

	const current = useEffectEvent((): PromptPresetEditorState => state);

	// @approved
	// Operations read their claim immediately after dispatch, and leave handoffs read
	// the settled state before starting selection. Commit the reducer update synchronously.
	const dispatch = (event: PromptPresetEditorEvent): void => {
		if (!alive.current) return;
		if (event.type === "operation-started" && event.effects.supersedesReads) void client.cancelQueries({ queryKey: recipeOptions.queryKey });
		flushSync(() => setState((previous) => reducePromptPresetEditorState(previous, event)));
	};

	const ownsOperation = (claim: OperationClaim): boolean =>
		alive.current && operationApplies(current(), claim);

	// @approved
	//  One operation settlement owner: a flow declares its start effects and
	// hands over its body, and this wrapper refuses a second operation while the first is active,
	// runs the body and settles only its own busy state. Because the settle happens synchronously
	// before `runOperation` resolves, a leave that starts its selection after `await runOperation(...)`
	// runs with busy already released.
	const runOperation = createPromptPresetEditorOperationRunner({
		current,
		dispatch,
		canStart: () => alive.current && !current().busy,
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
		refresh = true,
	): Promise<SelectedRecipeRead> => {
		if (conversation === null) {
			dispatch({ type: "recipe-unavailable" });
			return { status: "not-found" };
		}
		dispatch({ type: "read-started" });
		const claim = readClaim(current());
		try {
			const selected = refresh ? (await recipeQuery.refetch({ throwOnError: true })).data
				: await client.fetchQuery(recipeOptions);
			if (selected === undefined) return { status: "stale" };
			if (!alive.current || isCancelled?.() || !readApplies(current(), claim)) return { status: "stale" };
			if (selected === null) {
				dispatch({ type: "recipe-unavailable" });
				return { status: "not-found" };
			}
			return { status: "ready", claim, selected };
		} catch {
			if (!alive.current || isCancelled?.() || !readApplies(current(), claim)) return { status: "stale" };
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
	const load = async (isCancelled?: () => boolean, refresh = true): Promise<EditorLoadResult> => {
		const [presetsResult, selectedRead] = await Promise.all([
			(refresh ? libraryQuery.refetch({ throwOnError: true }).then((result) => result.data ?? []) : client.fetchQuery(libraryOptions)).then(
				(presets) => ({ status: "ready" as const, presets }),
				() => ({ status: "network" as const }),
			),
			readSelectedRecipe(isCancelled, refresh),
		]);
		if (selectedRead.status !== "ready") return selectedRead.status;
		if (!alive.current || isCancelled?.() || !readApplies(current(), selectedRead.claim)) return "stale";
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

	useAsyncEffect(async (isCancelled) => {
		await Promise.resolve();
		if (isCancelled() || !alive.current || recipeQuery.isFetching || recipeQuery.data === undefined || libraryQuery.data === undefined) return;
		if (current().session.key !== sessionKey) return;
		if (recipeQuery.data === null) dispatch({ type: "recipe-unavailable" });
		else dispatch({ type: "recipe-adopted", claim: readClaim(current()), selected: recipeQuery.data, presets: libraryQuery.data });
	}, [recipeQuery.data, recipeQuery.isFetching, libraryQuery.data, sessionKey]);

	const { view, drafts } = state;
	const ready = view.status === "ready" ? view : null;
	const { dirty, count } = ready === null
		? { dirty: false, count: 0 }
		: dirtyDraftSummary(ready.selected, drafts);
	const dirtyCount = count;

	useAsyncEffect(async (isCancelled) => {
		await Promise.resolve();
		if (isCancelled()) return;
		const currentState = current();
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
		void load(isCancelled, false);
	}, [conversation?.id, conversation?.revision]);

	return { state, current, ready, dirty, dirtyCount, dispatch, load, loadRecipe, runOperation, ownsOperation };
}
