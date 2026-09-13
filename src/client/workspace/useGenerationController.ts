import {
	useEffect,
	useReducer,
	useRef,
	useState,
	useSyncExternalStore,
	type Dispatch,
	type FormEvent,
	type RefObject,
} from "react";
import {
	previewConversationGeneration,
	startConversationContinuationGeneration,
	startConversationGeneration,
	startConversationSiblingGeneration,
	stopAllConversationGenerations,
	stopConversationGeneration,
	type ConversationSummary,
	type StopConversationGenerationResult,
	type GenerationPreviewBody,
} from "../conversation";
import type { PromptPlan } from "../../shared/contract/conversation-schema";
import { generationStreamAdapter } from "../conversation-stream";
import {
	createGenerationSessionRunner,
	type GenerationSessionRunner,
} from "../generation-session-runner";
import {
	firstActiveGenerationSessionError,
	hasActiveGenerationSessions,
	hasPendingGenerationStop,
	type GenerationSessionStoryEffect,
	type GenerationStopCommandOutcome,
} from "../generation-sessions";
import {
	createPendingGenerationStarts,
	reducePendingGenerationStarts,
} from "../pending-generation-starts";
import {
	canOfferSiblingGeneration,
	isModelAuthoredMessage,
	type StoryAction,
	type StoryMessage,
	type StoryState,
} from "../story";
import { canStartAssembly } from "../assembly";
import {
	isAssemblyPending,
	reduceAssemblySession,
	type AssemblySession,
} from "../assembly-session";
import { clientFormattingContext } from "../lib/formatting-context";

// ==[HUMAN APPROVED]== Maps a machine story effect onto the story reducer's vocabulary. Content
// deltas append into the story read model (the one accumulated story owner)
// and authoritative snapshots replace it. Reasoning Content follows a
// separate action path so it remains visible without joining authored prose.
export function generationSessionStoryAction(
	effect: GenerationSessionStoryEffect,
): StoryAction | null {
	switch (effect.kind) {
		case "story-content-delta":
			return {
				type: "generation-content-delta",
				messageId: effect.messageId,
				variantId: effect.variantId,
				text: effect.text,
				generationId: effect.generationId,
				eventId: effect.eventId,
			};
		case "story-state":
			return {
				type: "generation-state",
				messageId: effect.messageId,
				variantId: effect.variantId,
				content: effect.content,
				reasoning: effect.reasoning,
				generationId: effect.generationId,
				eventId: effect.eventId,
			};
		case "story-reasoning-delta":
			return {
				type: "generation-reasoning-delta",
				messageId: effect.messageId,
				variantId: effect.variantId,
				text: effect.text,
				generationId: effect.generationId,
				eventId: effect.eventId,
			};
	}
}

// ==[HUMAN APPROVED]== Maps a transport Stop outcome onto the machine's stop-command vocabulary.
const stopCommandOutcome = (
	result: StopConversationGenerationResult,
): GenerationStopCommandOutcome => {
	if (result.outcome === "failed") return { outcome: "failed", reason: result.reason };
	if (result.outcome === "not-found") return { outcome: "not-found" };
	return { outcome: "stopped" };
};

type GenerationControllerOptions = {
	conversation: ConversationSummary | null;
	story: StoryState;
	dispatchStory: Dispatch<StoryAction>;
	activeChatIdRef: RefObject<string>;
	refreshStory: (conversationId: number) => Promise<ConversationSummary | null>;
};

/**
 * ==[HUMAN APPROVED]== Thin wiring between the view, the Generation session machine, and the
 * server. The session machine (generation-sessions) and its runner own
 * subscription phases, event cursors, reconnection, stop state, errors, and
 * terminal refreshes; this hook only feeds authoritative snapshots into the
 * machine, sends start/stop commands, and renders the resulting state.
 */
export function useGenerationController({
	conversation,
	story,
	dispatchStory,
	activeChatIdRef,
	refreshStory,
}: GenerationControllerOptions) {
	const [draft, setDraft] = useState("");
	const [pendingStarts, dispatchPendingStarts] = useReducer(
		reducePendingGenerationStarts,
		undefined,
		createPendingGenerationStarts,
	);
	const nextStartIdRef = useRef(1);
	const [assembly, dispatchAssembly] = useReducer(reduceAssemblySession, null);
	const nextAssemblyRequestIdRef = useRef(1);
	const assemblyMountedRef = useRef(true);

	// ==[HUMAN APPROVED]== Assembly request identity is one monotonic counter: a request stays
	// current until a newer request, a cancellation, or a Chat switch advances it.
	const issueAssemblyRequestId = (): number => {
		const requestId = nextAssemblyRequestIdRef.current;
		nextAssemblyRequestIdRef.current += 1;
		return requestId;
	};
	const invalidateAssemblyRequests = (): void => {
		nextAssemblyRequestIdRef.current += 1;
	};
	const isCurrentAssemblyRequest = (requestId: number): boolean =>
		nextAssemblyRequestIdRef.current === requestId + 1;

	const runnerRef = useRef<GenerationSessionRunner | null>(null);
	if (runnerRef.current === null) {
		runnerRef.current = createGenerationSessionRunner({
			adapter: generationStreamAdapter,
			applyStoryEffect: (effect) => {
				const action = generationSessionStoryAction(effect);
				if (action !== null) dispatchStory(action);
			},
			refreshConversation: (conversationId) => {
				void refreshStory(conversationId);
			},
		});
	}
	const runner = runnerRef.current;

	// ==[HUMAN APPROVED]== Unmount detaches every local subscription. The machine keeps cursors,
	// so a later remount reattaches from each Generation's latest processed
	// event, and no server-owned Active Generation is ever cancelled here.
	useEffect(() => {
		assemblyMountedRef.current = true;
		return () => {
			assemblyMountedRef.current = false;
			runner.dispose();
		};
	}, [runner]);

	// ==[HUMAN APPROVED]== Authoritative snapshots reconcile the session collection. The dispatch
	// is idempotent, so re-observing unchanged targets has no effect and no
	// joined dependency keys are needed.
	useEffect(() => {
		if (conversation === null) return;
		runner.dispatch({
			type: "targets-observed",
			conversationId: conversation.id,
			targets: conversation.activeGenerations.map(({ generationId, messageId, variantId }) => {
				const variant = story.messages
					.find((message) => message.id === messageId)
					?.swipes.find((entry) => entry.id === variantId);
				return {
					generationId,
					messageId,
					variantId,
					initialEventId: variant?.generationId === generationId
						? variant.lastEventId
						: undefined,
				};
			}),
		});
	}, [runner, conversation, story]);

	const sessions = useSyncExternalStore(runner.subscribe, runner.getSnapshot);
	const hasSessions = hasActiveGenerationSessions(sessions);
	const isGenerating = pendingStarts.size > 0 || hasSessions;
	const stopPending = hasPendingGenerationStop(sessions);
	const generationError = firstActiveGenerationSessionError(sessions);

	useEffect(() => {
		dispatchPendingStarts({
			type: "sessions-observed",
			generationIds: new Set(sessions.sessions.keys()),
		});
	}, [pendingStarts, sessions]);

	const activeGenerationTargets = conversation === null
		? []
		: conversation.activeGenerations;
	const activeGenerationMessageIds = activeGenerationTargets.map((generation) => generation.messageId);
	const selectedGenerationTarget = activeGenerationTargets.find((target) => {
		const message = story.messages.find((entry) => entry.id === target.messageId);
		return message?.swipes[message.activeSwipe]?.id === target.variantId;
	}) ?? activeGenerationTargets[0];

	const conversationSwitched = () => {
		dispatchPendingStarts({ type: "conversation-switched" });
		invalidateAssemblyRequests();
		dispatchAssembly({ type: "conversation-switched" });
		runner.dispatch({ type: "conversation-switched" });
	};

	const canApplyAssemblyEffect = (requestId: number, conversationId: number) =>
		assemblyMountedRef.current &&
		isCurrentAssemblyRequest(requestId) &&
		Number(activeChatIdRef.current) === conversationId;

	const beginAssemblyRequest = (
		request: GenerationPreviewBody,
		preservedPreview: AssemblySession["preview"] = null,
	) => {
		if (conversation === null) return;
		const conversationId = conversation.id;
		const requestId = issueAssemblyRequestId();
		dispatchAssembly({
			type: "started",
			conversationId,
			requestId,
			request,
			preview: preservedPreview,
		});
		void previewConversationGeneration(conversationId, request)
			.then((outcome) => {
				if (!canApplyAssemblyEffect(requestId, conversationId)) return;
				if (outcome.status === "available") {
					dispatchAssembly({ type: "preview-available", requestId, preview: outcome.preview });
					return;
				}
				dispatchAssembly({
					type: "preview-failed",
					requestId,
					error: outcome.status === "invalid"
						? outcome.reason
						: outcome.status === "not-found"
							? "The Conversation no longer exists."
							: "The Prompt Plan could not be assembled.",
				});
			})
			.catch(() => {
				if (!canApplyAssemblyEffect(requestId, conversationId)) return;
				dispatchAssembly({
					type: "preview-failed",
					requestId,
					error: "The Prompt Plan could not be assembled.",
				});
			});
	};

	const openPromptPlanPreview = (request: GenerationPreviewBody) => {
		if (conversation === null || assembly !== null) return;
		beginAssemblyRequest(request);
	};

	const refreshPromptPlanPreview = () => {
		if (assembly === null || isAssemblyPending(assembly)) return;
		beginAssemblyRequest(assembly.request, assembly.preview);
	};

	const cancelPromptPlanPreview = () => {
		if (assembly === null || assembly.phase === "accepting") return;
		invalidateAssemblyRequests();
		dispatchAssembly({ type: "cancelled", requestId: assembly.requestId });
	};

	const editPromptPlanPreview = (promptPlan: PromptPlan) => {
		if (assembly === null) return;
		dispatchAssembly({ type: "plan-edited", requestId: assembly.requestId, promptPlan });
	};

	const stopGeneration = async (generationId: number) => {
		const conversationId = conversation?.id;
		if (conversationId === undefined || stopPending) return;
		runner.dispatch({ type: "errors-acknowledged" });
		runner.dispatch({ type: "stop-started", generationId });
		try {
			const outcome = await stopConversationGeneration(conversationId, generationId);
			runner.dispatch({ type: "stop-settled", generationId, outcome: stopCommandOutcome(outcome) });
		} catch {
			runner.dispatch({
				type: "stop-settled",
				generationId,
				outcome: { outcome: "failed", reason: "Generation could not be stopped." },
			});
		}
	};

	const stopAllGenerations = async () => {
		const conversationId = conversation?.id;
		if (conversationId === undefined || activeGenerationTargets.length < 2 || stopPending) return;
		runner.dispatch({ type: "errors-acknowledged" });
		runner.dispatch({ type: "stop-all-started" });
		try {
			const outcome = await stopAllConversationGenerations(conversationId);
			runner.dispatch({ type: "stop-all-settled", outcome: stopCommandOutcome(outcome) });
		} catch {
			runner.dispatch({
				type: "stop-all-settled",
				outcome: { outcome: "failed", reason: "Generations could not be stopped." },
			});
		}
	};

	const cancelGeneration = () => {
		const target = selectedGenerationTarget?.generationId;
		if (target !== undefined) void stopGeneration(target);
	};

	const startGeneration = async (
		startId: number,
		conversationId: number,
		assemblyRequestId: number,
		request: Promise<Awaited<ReturnType<typeof startConversationGeneration>>>,
		clearDraftOnAccepted: boolean,
	) => {
		let outcome: Awaited<ReturnType<typeof startConversationGeneration>>;
		try {
			outcome = await request;
		} catch {
			if (!canApplyAssemblyEffect(assemblyRequestId, conversationId)) return;
			dispatchPendingStarts({ type: "settled", startId });
			dispatchAssembly({
				type: "acceptance-failed",
				requestId: assemblyRequestId,
				error: "Generation could not be started.",
			});
			return;
		}
		if (!canApplyAssemblyEffect(assemblyRequestId, conversationId)) return;
		if (outcome.outcome !== "accepted") {
			dispatchPendingStarts({ type: "settled", startId });
			dispatchAssembly({
				type: "acceptance-failed",
				requestId: assemblyRequestId,
				error:
					outcome.outcome === "not-found"
						? "The Conversation no longer exists."
						: (outcome.reason ?? "Generation could not be started."),
			});
			return;
		}

		dispatchAssembly({ type: "acceptance-succeeded", requestId: assemblyRequestId });
		if (clearDraftOnAccepted) setDraft("");
		let freshConversation: ConversationSummary | null;
		try {
			freshConversation = await refreshStory(conversationId);
		} catch {
			if (!canApplyAssemblyEffect(assemblyRequestId, conversationId)) return;
			dispatchPendingStarts({ type: "settled", startId });
			return;
		}
		if (!canApplyAssemblyEffect(assemblyRequestId, conversationId)) return;
		if (
			freshConversation === null ||
			!freshConversation.activeGenerations.some(
				(generation) => generation.generationId === outcome.generationId,
			)
		) {
			dispatchPendingStarts({ type: "settled", startId });
		} else {
			dispatchPendingStarts({
				type: "accepted",
				startId,
				generationId: outcome.generationId,
			});
		}
	};

	const beginStart = () => {
		const startId = nextStartIdRef.current;
		nextStartIdRef.current += 1;
		dispatchPendingStarts({ type: "started", startId });
		runner.dispatch({ type: "errors-acknowledged" });
		return startId;
	};

	const sendPromptPlanPreview = () => {
		const currentAssembly = assembly;
		if (
			conversation === null ||
			currentAssembly === null ||
			currentAssembly.preview === null ||
			(currentAssembly.phase !== "ready" && currentAssembly.phase !== "failed")
		) return;
		const conversationId = conversation.id;
		const { preview, request, requestId } = currentAssembly;
		const startId = beginStart();
		dispatchAssembly({ type: "acceptance-started", requestId });
		const previewInput = { previewId: preview.previewId, promptPlan: preview.promptPlan };
		const formatting = { timeZone: request.timeZone, locale: request.locale };
		const start = request.kind === "send"
			? startConversationGeneration(conversationId, conversation.revision, request.content ?? "", formatting, previewInput)
			: request.kind === "continuation"
				? startConversationContinuationGeneration(conversationId, conversation.revision, formatting, previewInput)
				: startConversationSiblingGeneration(conversationId, request.messageId!, formatting, previewInput);
		void startGeneration(
			startId,
			conversationId,
			requestId,
			start,
			request.kind === "send",
		);
	};

	const submitMessage = (event: FormEvent) => {
		event.preventDefault();
		if (!assemblyAvailable || conversation === null || draft.trim() === "") return;
		openPromptPlanPreview({ kind: "send", content: draft, ...clientFormattingContext() });
	};

	const continueMessage = (messageId: number) => {
		if (!assemblyAvailable || conversation === null) return;
		const latest = story.messages.at(-1);
		if (
			latest?.id !== messageId ||
			latest.continuable !== true ||
			!isModelAuthoredMessage(latest)
		) return;
		openPromptPlanPreview({ kind: "continuation", ...clientFormattingContext() });
	};

	const siblingMessage = (messageId: number) => {
		if (!assemblyAvailable || conversation === null) return;
		const target = story.messages.find((message) => message.id === messageId);
		if (
			target === undefined ||
			!canOfferSiblingGeneration({
				message: target,
				playable: conversation.playable,
				previewActive: story.preview !== null,
				activeGenerationMessageIds,
			})
		) return;
		openPromptPlanPreview({ kind: "sibling", messageId, ...clientFormattingContext() });
	};

	const assemblyAvailable = canStartAssembly({
		playable: conversation?.playable === true,
		isGenerating,
		assemblyActive: assembly !== null,
		variantPreviewActive: story.preview !== null,
	});

	const canOfferSiblingMessage = (message: StoryMessage) =>
		assemblyAvailable && conversation !== null && canOfferSiblingGeneration({
			message,
			playable: conversation.playable,
			previewActive: story.preview !== null,
			activeGenerationMessageIds,
		});

	return {
		draft,
		setDraft,
		isGenerating,
		stopPending,
		generationError,
		assembly,
		editPromptPlanPreview,
		refreshPromptPlanPreview,
		cancelPromptPlanPreview,
		sendPromptPlanPreview,
		openPromptPlanPreview,
		assemblyAvailable,
		activeGenerationTargets,
		activeGenerationMessageIds,
		selectedGenerationTarget,
		conversationSwitched,
		stopGeneration,
		stopAllGenerations,
		cancelGeneration,
		submitMessage,
		continueMessage,
		siblingMessage,
		canOfferSiblingMessage,
	};
}
