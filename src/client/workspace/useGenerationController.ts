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
	stopAllConversationGenerations,
	stopConversationGeneration,
	type ConversationSummary,
	type GenerationStopResult,
} from "../conversation";
import { generationStreamAdapter } from "../conversation-stream";
import {
	createGenerationSessionRunner,
	type GenerationSessionRunner,
} from "../generation-session-runner";
import {
	firstActiveGenerationSessionFailure,
	hasActiveGenerationSessions,
	hasPendingGenerationStop,
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
import { clientFormattingContext } from "../lib/formatting-context";
import { useAssemblyController } from "./useAssemblyController";

// @approved
//  Maps a transport Stop outcome onto the machine's stop-command vocabulary.
// The transport's network outcome is the machine's failed stop; the reason is
// owned here because the transport no longer words per-route failures.
const stopCommandOutcome = (
	result: GenerationStopResult,
): GenerationStopCommandOutcome => {
	if (result.outcome === "not-found") return { outcome: "not-found" };
	if (result.outcome === "network") return { outcome: "failed", reason: "Generation could not be stopped." };
	return { outcome: "stopped" };
};

type GenerationControllerOptions = {
	conversation: ConversationSummary | null;
	story: StoryState;
	dispatchStory: Dispatch<StoryAction>;
	activeChatIdRef: RefObject<string>;
	refreshStory: (conversationId: number, signal?: AbortSignal) => Promise<ConversationSummary | null>;
	ensureLatest: () => Promise<ConversationSummary | null>;
	inspectPromptPlanBeforeGenerating: boolean;
};

/**
 * ==[HUMAN APPROVED]== Thin wiring between the view, the Generation session machine, and the
 * assembly controller. The session machine (generation-sessions) and its runner own
 * subscription phases, event cursors, reconnection, stop state, errors, and
 * terminal refreshes; the assembly controller owns Prompt Plan preview and
 * acceptance while this hook renders the combined state and composer actions.
 */
export function useGenerationController({
	conversation,
	story,
	dispatchStory,
	activeChatIdRef,
	refreshStory,
	ensureLatest,
	inspectPromptPlanBeforeGenerating,
}: GenerationControllerOptions) {
	const [draft, setDraft] = useState("");
	const [pendingStarts, dispatchPendingStarts] = useReducer(
		reducePendingGenerationStarts,
		undefined,
		createPendingGenerationStarts,
	);
	const nextStartIdRef = useRef(1);

	const runnerRef = useRef<GenerationSessionRunner | null>(null);
	if (runnerRef.current === null) {
		runnerRef.current = createGenerationSessionRunner({
			adapter: generationStreamAdapter,
			applyStoryEffect: dispatchStory,
			refreshConversation: async (conversationId, signal) => {
				await refreshStory(conversationId, signal);
			},
		});
	}
	const runner = runnerRef.current;

	// @approved
	//  Unmount detaches every local subscription. The machine keeps cursors,
	// so a later remount reattaches from each Generation's latest processed
	// event, and no server-owned Active Generation is ever cancelled here.
	useEffect(() => {
		return () => {
			runner.dispose();
		};
	}, [runner]);

	// @approved
	//  Authoritative snapshots reconcile the session collection. The dispatch
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
	const sessionFailure = firstActiveGenerationSessionFailure(sessions);
	const sessionError = sessionFailure?.reason ?? null;
	const failedImageModel = sessionFailure?.imageModel ?? null;

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

	const beginStart = () => {
		const startId = nextStartIdRef.current;
		nextStartIdRef.current += 1;
		dispatchPendingStarts({ type: "started", startId });
		runner.dispatch({ type: "errors-acknowledged" });
		return startId;
	};

	const assemblyController = useAssemblyController({
		conversation,
		activeChatIdRef,
		refreshStory,
		ensureLatest,
		isGenerating,
		variantPreviewActive: story.preview !== null,
		inspectPromptPlanBeforeGenerating,
		generationStart: {
			begin: beginStart,
			settle: (startId) => dispatchPendingStarts({ type: "settled", startId }),
			accepted: (startId, target) => {
				dispatchPendingStarts({ type: "accepted", startId, generationId: target.generationId });
				runner.dispatch({ type: "generation-accepted", target });
			},
		},
		clearDraft: () => setDraft(""),
	});
	const {
		assembly,
		assemblyAvailable,
		editPromptPlanPreview,
		refreshPromptPlanPreview,
		cancelPromptPlanPreview,
		sendPromptPlanPreview,
		requestGeneration,
		retryGeneration,
		directStartError,
		acknowledgeDirectStartError,
	} = assemblyController;
	const generationError = directStartError ?? sessionError;
	const acknowledgeGenerationError = () => {
		acknowledgeDirectStartError();
		runner.dispatch({ type: "errors-acknowledged" });
	};

	const conversationSwitched = () => {
		dispatchPendingStarts({ type: "conversation-switched" });
		assemblyController.conversationSwitched();
		runner.dispatch({ type: "conversation-switched" });
	};

	const stopGeneration = async (generationId: number) => {
		const conversationId = conversation?.id;
		if (conversationId === undefined || stopPending) return;
		runner.dispatch({ type: "errors-acknowledged" });
		runner.dispatch({ type: "stop-started", generationId });
		// @approved
		//  The transport classifies every failure itself; it never rejects.
		const outcome = await stopConversationGeneration(conversationId, generationId);
		runner.dispatch({ type: "stop-settled", generationId, outcome: stopCommandOutcome(outcome) });
	};

	const stopAllGenerations = async () => {
		const conversationId = conversation?.id;
		if (conversationId === undefined || activeGenerationTargets.length < 2 || stopPending) return;
		runner.dispatch({ type: "errors-acknowledged" });
		runner.dispatch({ type: "stop-all-started" });
		// @approved
		//  The transport classifies every failure itself; it never rejects.
		const outcome = await stopAllConversationGenerations(conversationId);
		runner.dispatch({ type: "stop-all-settled", outcome: stopCommandOutcome(outcome) });
	};

	const cancelGeneration = () => {
		const target = selectedGenerationTarget?.generationId;
		if (target !== undefined) void stopGeneration(target);
	};

	const submitMessage = (event: FormEvent) => {
		event.preventDefault();
		if (!assemblyAvailable || conversation === null || draft.trim() === "") return;
		requestGeneration({ kind: "send", content: draft, ...clientFormattingContext() });
	};

	const continueMessage = (messageId: number) => {
		if (!assemblyAvailable || conversation === null) return;
		const latest = story.page?.hasNewer ? undefined : story.messages.at(-1);
		if (
			latest?.id !== messageId ||
			latest.continuable !== true ||
			!isModelAuthoredMessage(latest)
		) return;
		requestGeneration({ kind: "continuation", ...clientFormattingContext() });
	};

	const regenerateResponse = (messageId: number) => {
		if (!assemblyAvailable || conversation === null) return;
		const latest = story.page?.hasNewer ? undefined : story.messages.at(-1);
		const content = latest?.swipes[latest.activeSwipe]?.content;
		if (
			latest?.id !== messageId ||
			latest.authorParticipantId !== conversation.control.humanParticipantId ||
			content === undefined ||
			content.trim() === ""
		) return;
		requestGeneration({ kind: "send", content, ...clientFormattingContext() });
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
		requestGeneration({ kind: "sibling", messageId, ...clientFormattingContext() });
	};

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
		generationImageModel: directStartError === null ? failedImageModel : null,
		retryGeneration,
		acknowledgeGenerationError,
		assembly,
		editPromptPlanPreview,
		refreshPromptPlanPreview,
		cancelPromptPlanPreview,
		sendPromptPlanPreview,
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
		regenerateResponse,
		siblingMessage,
		canOfferSiblingMessage,
	};
}
