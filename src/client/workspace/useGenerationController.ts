import {
	useEffect,
	useRef,
	useReducer,
	useState,
	type Dispatch,
	type FormEvent,
	type RefObject,
} from "react";
import {
	startConversationContinuationGeneration,
	startConversationGeneration,
	startConversationSiblingGeneration,
	stopAllConversationGenerations,
	stopConversationGeneration,
	type ConversationSummary,
	type StopConversationGenerationResult,
} from "../conversation";
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
	canOfferSiblingGeneration,
	isModelAuthoredMessage,
	type StoryAction,
	type StoryMessage,
	type StoryState,
} from "../story";

// Maps a machine story effect onto the story reducer's vocabulary. Content
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
			};
		case "story-content-replace":
			return {
				type: "generation-content",
				messageId: effect.messageId,
				variantId: effect.variantId,
				content: effect.content,
			};
		case "story-reasoning-delta":
			return {
				type: "generation-reasoning-delta",
				messageId: effect.messageId,
				variantId: effect.variantId,
				text: effect.text,
			};
		case "story-reasoning-replace":
			return {
				type: "generation-reasoning",
				messageId: effect.messageId,
				variantId: effect.variantId,
				reasoning: effect.reasoning,
			};
	}
}

// Maps a transport Stop outcome onto the machine's stop-command vocabulary.
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
 * Thin wiring between the view, the Generation session machine, and the
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
	const [startPending, setStartPending] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);
	const [, rerender] = useReducer((count: number) => count + 1, 0);

	// The runner is created once; host callbacks route through this ref,
	// refreshed every render, so the runner never observes a stale closure
	// even if a host callback's identity changes between renders.
	const hostRef = useRef<{
		dispatchStory: Dispatch<StoryAction>;
		refreshStory: (conversationId: number) => Promise<ConversationSummary | null>;
	} | null>(null);
	hostRef.current = { dispatchStory, refreshStory };

	const runnerRef = useRef<GenerationSessionRunner | null>(null);
	if (runnerRef.current === null) {
		runnerRef.current = createGenerationSessionRunner({
			adapter: generationStreamAdapter,
			applyStoryEffect: (effect) => {
				const action = generationSessionStoryAction(effect);
				if (action !== null) hostRef.current?.dispatchStory(action);
			},
			refreshConversation: (conversationId) => {
				void hostRef.current?.refreshStory(conversationId);
			},
			onStateChange: () => rerender(),
		});
	}
	const runner = runnerRef.current;

	// Unmount detaches every local subscription. The machine keeps cursors,
	// so a later remount reattaches from each Generation's latest processed
	// event, and no server-owned Active Generation is ever cancelled here.
	useEffect(() => () => runner.dispose(), [runner]);

	// Authoritative snapshots reconcile the session collection. The dispatch
	// is idempotent, so re-observing unchanged targets has no effect and no
	// joined dependency keys are needed.
	useEffect(() => {
		if (conversation === null) return;
		runner.dispatch({
			type: "targets-observed",
			conversationId: conversation.id,
			targets: conversation.activeGenerations.map(({ generationId, messageId, variantId }) => ({
				generationId,
				messageId,
				variantId,
			})),
		});
	}, [runner, conversation]);

	const sessions = runner.snapshot();
	const hasSessions = hasActiveGenerationSessions(sessions);
	const isGenerating = startPending || hasSessions;
	const stopPending = hasPendingGenerationStop(sessions);
	const generationError = startError ?? firstActiveGenerationSessionError(sessions);

	// The first observed session retires the start-pending flag; session
	// state owns generation activity from acceptance onward.
	useEffect(() => {
		if (startPending && hasSessions) setStartPending(false);
	}, [startPending, hasSessions]);

	const activeGenerationTargets = conversation === null
		? []
		: conversation.activeGenerations;
	const activeGenerationMessageIds = activeGenerationTargets.map((generation) => generation.messageId);
	const selectedGenerationTarget = activeGenerationTargets.find((target) => {
		const message = story.messages.find((entry) => entry.id === target.messageId);
		return message?.swipes[message.activeSwipe]?.id === target.variantId;
	}) ?? activeGenerationTargets[0];

	const conversationSwitched = () => {
		setStartPending(false);
		setStartError(null);
		runner.dispatch({ type: "conversation-switched" });
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
				// Accepted starts hand activity over to the session machine; the
				// start-pending flag only persists until the refreshed snapshot
				// is observed (or proves there is nothing to observe).
				if (freshConversation === null || freshConversation.activeGenerations.length === 0) {
					setStartPending(false);
				}
				return;
			}
			setStartPending(false);
			setStartError(
				outcome.outcome === "not-found"
					? "The Conversation no longer exists."
					: (outcome.reason ?? "Generation could not be started."),
			);
		} catch {
			if (Number(activeChatIdRef.current) !== conversationId) return;
			setStartPending(false);
			setStartError("Generation could not be started.");
		}
	};

	const beginStart = () => {
		setStartPending(true);
		setStartError(null);
		runner.dispatch({ type: "errors-acknowledged" });
	};

	const submitMessage = (event: FormEvent) => {
		event.preventDefault();
		if (story.preview !== null || isGenerating || conversation === null || !conversation.playable || draft.trim() === "") return;
		const conversationId = conversation.id;
		beginStart();
		void startGeneration(
			conversationId,
			startConversationGeneration(conversationId, conversation.revision, draft),
			() => setDraft(""),
		);
	};

	const continueMessage = (messageId: number) => {
		if (story.preview !== null || isGenerating || conversation === null || !conversation.playable) return;
		const latest = story.messages.at(-1);
		if (
			latest?.id !== messageId ||
			latest.continuable !== true ||
			!isModelAuthoredMessage(latest, conversation.control.modelParticipantId)
		) return;
		const conversationId = conversation.id;
		beginStart();
		void startGeneration(
			conversationId,
			startConversationContinuationGeneration(conversationId, conversation.revision),
		);
	};

	const siblingMessage = (messageId: number) => {
		if (story.preview !== null || conversation === null || !conversation.playable) return;
		const target = story.messages.find((message) => message.id === messageId);
		if (
			target === undefined ||
			!canOfferSiblingGeneration({
				message: target,
				playable: conversation.playable,
				previewActive: story.preview !== null,
				modelParticipantId: conversation.control.modelParticipantId,
				activeGenerationMessageIds,
			})
		) return;
		const conversationId = conversation.id;
		beginStart();
		void startGeneration(
			conversationId,
			startConversationSiblingGeneration(conversationId, messageId),
		);
	};

	const canOfferSiblingMessage = (message: StoryMessage) =>
		conversation !== null && canOfferSiblingGeneration({
			message,
			playable: conversation.playable,
			previewActive: story.preview !== null,
			modelParticipantId: conversation.control.modelParticipantId,
			activeGenerationMessageIds,
		});

	return {
		draft,
		setDraft,
		isGenerating,
		stopPending,
		generationError,
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
