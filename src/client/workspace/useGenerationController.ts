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
	type GenerationPreview,
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

const macroFormattingContext = () => {
	const resolved = Intl.DateTimeFormat().resolvedOptions();
	return { timeZone: resolved.timeZone, locale: resolved.locale };
};

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

type PromptPlanPreviewState = {
	preview: GenerationPreview;
	request: GenerationPreviewBody;
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
	const [startError, setStartError] = useState<string | null>(null);
	const [promptPlanPreview, setPromptPlanPreview] = useState<PromptPlanPreviewState | null>(null);
	const [promptPlanPreviewPending, setPromptPlanPreviewPending] = useState(false);
	const [promptPlanPreviewError, setPromptPlanPreviewError] = useState<string | null>(null);

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
	useEffect(() => () => runner.dispose(), [runner]);

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
	const generationError = startError ?? firstActiveGenerationSessionError(sessions);

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
		setStartError(null);
		setPromptPlanPreview(null);
		setPromptPlanPreviewPending(false);
		setPromptPlanPreviewError(null);
		runner.dispatch({ type: "conversation-switched" });
	};

	const requestPromptPlanPreview = async (request: GenerationPreviewBody) => {
		if (conversation === null || promptPlanPreviewPending) return;
		setPromptPlanPreviewPending(true);
		setPromptPlanPreviewError(null);
		const conversationId = conversation.id;
		const outcome = await previewConversationGeneration(conversationId, request);
		if (Number(activeChatIdRef.current) !== conversationId) return;
		setPromptPlanPreviewPending(false);
		if (outcome.status === "available") {
			setPromptPlanPreview({ preview: outcome.preview, request });
			return;
		}
		setPromptPlanPreviewError(
			outcome.status === "invalid"
				? outcome.reason
				: outcome.status === "not-found"
					? "The Conversation no longer exists."
					: "The Prompt Plan could not be assembled.",
		);
	};

	const openPromptPlanPreview = (request: GenerationPreviewBody) => {
		if (conversation === null || promptPlanPreviewPending) return;
		void requestPromptPlanPreview(request);
	};

	const refreshPromptPlanPreview = () => {
		if (promptPlanPreview === null) return;
		void requestPromptPlanPreview(promptPlanPreview.request);
	};

	const cancelPromptPlanPreview = () => {
		setPromptPlanPreview(null);
		setPromptPlanPreviewError(null);
	};

	const editPromptPlanPreview = (promptPlan: PromptPlan) => {
		setPromptPlanPreview((current) => current === null
			? current
			: { ...current, preview: { ...current.preview, promptPlan } });
		setPromptPlanPreviewError(null);
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
		request: Promise<Awaited<ReturnType<typeof startConversationGeneration>>>,
		onAccepted?: () => void,
	) => {
		try {
			const outcome = await request;
			if (Number(activeChatIdRef.current) !== conversationId) return;
			if (outcome.outcome === "accepted") {
				onAccepted?.();
				const freshConversation = await refreshStory(conversationId);
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
				return;
			}
			dispatchPendingStarts({ type: "settled", startId });
			setStartError(
				outcome.outcome === "not-found"
					? "The Conversation no longer exists."
					: (outcome.reason ?? "Generation could not be started."),
			);
		} catch {
			if (Number(activeChatIdRef.current) !== conversationId) return;
			dispatchPendingStarts({ type: "settled", startId });
			setStartError("Generation could not be started.");
		}
	};

	const beginStart = () => {
		const startId = nextStartIdRef.current;
		nextStartIdRef.current += 1;
		dispatchPendingStarts({ type: "started", startId });
		setStartError(null);
		runner.dispatch({ type: "errors-acknowledged" });
		return startId;
	};

	const sendPromptPlanPreview = () => {
		if (conversation === null || promptPlanPreview === null || promptPlanPreviewPending) return;
		const conversationId = conversation.id;
		const startId = beginStart();
		const { preview, request } = promptPlanPreview;
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
			start,
			() => {
				setPromptPlanPreview(null);
				setPromptPlanPreviewError(null);
				if (request.kind === "send") setDraft("");
			},
		);
	};

	const submitMessage = (event: FormEvent) => {
		event.preventDefault();
		if (story.preview !== null || isGenerating || promptPlanPreview !== null || promptPlanPreviewPending || conversation === null || !conversation.playable || draft.trim() === "") return;
		openPromptPlanPreview({ kind: "send", content: draft, ...macroFormattingContext() });
	};

	const continueMessage = (messageId: number) => {
		if (story.preview !== null || isGenerating || promptPlanPreview !== null || promptPlanPreviewPending || conversation === null || !conversation.playable) return;
		const latest = story.messages.at(-1);
		if (
			latest?.id !== messageId ||
			latest.continuable !== true ||
			!isModelAuthoredMessage(latest)
		) return;
		openPromptPlanPreview({ kind: "continuation", ...macroFormattingContext() });
	};

	const siblingMessage = (messageId: number) => {
		if (story.preview !== null || promptPlanPreview !== null || promptPlanPreviewPending || conversation === null || !conversation.playable) return;
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
		openPromptPlanPreview({ kind: "sibling", messageId, ...macroFormattingContext() });
	};

	const canOfferSiblingMessage = (message: StoryMessage) =>
		conversation !== null && canOfferSiblingGeneration({
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
		promptPlanPreview,
		promptPlanPreviewPending,
		promptPlanPreviewError,
		editPromptPlanPreview,
		refreshPromptPlanPreview,
		cancelPromptPlanPreview,
		sendPromptPlanPreview,
		openPromptPlanPreview,
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
