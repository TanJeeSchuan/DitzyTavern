import {
	useEffect,
	useRef,
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
	subscribeConversationGeneration,
	type ConversationSummary,
} from "../conversation";
import {
	canOfferSiblingGeneration,
	isModelAuthoredMessage,
	type StoryAction,
	type StoryMessage,
	type StoryState,
} from "../story";

type GenerationControllerOptions = {
	conversation: ConversationSummary | null;
	story: StoryState;
	dispatchStory: Dispatch<StoryAction>;
	activeChatIdRef: RefObject<string>;
	refreshStory: (conversationId: number) => Promise<ConversationSummary | null>;
};

/**
 * Owns server-generation observation and commands. Acceptance, streaming,
 * stopping, and recovery stay together so the view only renders the current
 * generation state and wires the relevant actions to controls.
 */
export function useGenerationController({
	conversation,
	story,
	dispatchStory,
	activeChatIdRef,
	refreshStory,
}: GenerationControllerOptions) {
	const [draft, setDraft] = useState("");
	const [isGenerating, setIsGenerating] = useState(false);
	const [stopPending, setStopPending] = useState(false);
	const [generationError, setGenerationError] = useState<string | null>(null);
	const generationSubscriptionAbortRef = useRef<AbortController | null>(null);

	const activeGenerationTargets = conversation === null
		? []
		: conversation.activeGenerations;
	const activeGenerationMessageIds = activeGenerationTargets.map((generation) => generation.messageId);
	const selectedGenerationTarget = activeGenerationTargets.find((target) => {
		const message = story.messages.find((entry) => entry.id === target.messageId);
		return message?.swipes[message.activeSwipe]?.id === target.variantId;
	}) ?? activeGenerationTargets[0];

	useEffect(() => () => {
		generationSubscriptionAbortRef.current?.abort();
		generationSubscriptionAbortRef.current = null;
	}, []);

	// A Conversation snapshot carries the server-owned provisional target. On
	// reload or after returning from another Chat, subscribe from event zero so
	// the server replays the authoritative stream/checkpoint before live events.
	useEffect(() => {
		if (activeGenerationTargets.length === 0 || conversation === null) return;

		const controller = new AbortController();
		generationSubscriptionAbortRef.current?.abort();
		generationSubscriptionAbortRef.current = controller;
		const conversationId = conversation.id;
		let current = true;
		setIsGenerating(true);
		const outputByGeneration = new Map<number, { content: string; reasoning: string }>();
		for (const target of activeGenerationTargets) {
			outputByGeneration.set(target.generationId, { content: "", reasoning: "" });
		}

		const subscriptions = activeGenerationTargets.map((target) =>
			subscribeConversationGeneration(conversationId, target.generationId, {
				signal: controller.signal,
				onDelta: (event) => {
					if (!current || Number(activeChatIdRef.current) !== conversationId) return;
					const output = outputByGeneration.get(target.generationId) ?? { content: "", reasoning: "" };
					if (event.type === "content") output.content += event.text;
					if (event.type === "reasoning") output.reasoning += event.text;
					outputByGeneration.set(target.generationId, output);
					dispatchStory({
						type: "generation-content",
						messageId: target.messageId,
						variantId: target.variantId,
						content: output.content,
					});
				},
				onState: (state) => {
					if (!current || Number(activeChatIdRef.current) !== conversationId) return;
					outputByGeneration.set(target.generationId, {
						content: state.content,
						reasoning: state.reasoning,
					});
					dispatchStory({
						type: "generation-content",
						messageId: target.messageId,
						variantId: target.variantId,
						content: state.content,
					});
				},
			}),
		);

		void Promise.all(subscriptions).then(async (results) => {
			if (!current) return;
			const failed = results.find((result) =>
				result.outcome === "failed" ||
				result.outcome === "invalid" ||
				result.outcome === "conflict" ||
				result.outcome === "not-playable",
			);
			if (failed !== undefined && failed.outcome !== "stopped" && failed.outcome !== "not-found" && failed.outcome !== "applied") {
				setGenerationError(failed.reason);
			}
			await refreshStory(conversationId);
		}).finally(() => {
			if (!current || Number(activeChatIdRef.current) !== conversationId) return;
			setIsGenerating(false);
			if (generationSubscriptionAbortRef.current === controller) {
				generationSubscriptionAbortRef.current = null;
			}
		});

		return () => {
			current = false;
			controller.abort();
			if (generationSubscriptionAbortRef.current === controller) {
				generationSubscriptionAbortRef.current = null;
			}
		};
	}, [
		conversation?.id,
		conversation?.activeGenerations.map((target) => target.generationId).join(","),
	]);

	const resetForChatChange = () => {
		generationSubscriptionAbortRef.current?.abort();
		generationSubscriptionAbortRef.current = null;
		setIsGenerating(false);
		setGenerationError(null);
	};

	const stopGeneration = async (generationId: number) => {
		const conversationId = conversation?.id;
		if (conversationId === undefined || stopPending) return;
		setStopPending(true);
		setGenerationError(null);
		try {
			const outcome = await stopConversationGeneration(conversationId, generationId);
			// This abort only ends this browser's local subscription. The explicit
			// Stop command above owns provider cancellation on the server.
			generationSubscriptionAbortRef.current?.abort();
			generationSubscriptionAbortRef.current = null;
			setIsGenerating(false);
			await refreshStory(conversationId);
			if (outcome.outcome === "failed") setGenerationError(outcome.reason);
		} catch {
			setGenerationError("Generation could not be stopped.");
		} finally {
			setStopPending(false);
		}
	};

	const stopAllGenerations = async () => {
		const conversationId = conversation?.id;
		if (conversationId === undefined || activeGenerationTargets.length < 2 || stopPending) return;
		setStopPending(true);
		setGenerationError(null);
		try {
			const outcome = await stopAllConversationGenerations(conversationId);
			generationSubscriptionAbortRef.current?.abort();
			generationSubscriptionAbortRef.current = null;
			setIsGenerating(false);
			await refreshStory(conversationId);
			if (outcome.outcome === "failed") setGenerationError(outcome.reason);
		} catch {
			setGenerationError("Generations could not be stopped.");
		} finally {
			setStopPending(false);
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
				if (freshConversation === null || freshConversation.activeGenerations.length === 0) {
					setIsGenerating(false);
				}
				return;
			}
			setIsGenerating(false);
			setGenerationError(
				outcome.outcome === "not-found"
					? "The Conversation no longer exists."
					: (outcome.reason ?? "Generation could not be started."),
			);
		} catch {
			if (Number(activeChatIdRef.current) !== conversationId) return;
			setIsGenerating(false);
			setGenerationError("Generation could not be started.");
		}
	};

	const submitMessage = (event: FormEvent) => {
		event.preventDefault();
		if (story.preview !== null || isGenerating || conversation === null || !conversation.playable || draft.trim() === "") return;
		const conversationId = conversation.id;
		setIsGenerating(true);
		setGenerationError(null);
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
		setIsGenerating(true);
		setGenerationError(null);
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
		setIsGenerating(true);
		setGenerationError(null);
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
		resetForChatChange,
		stopGeneration,
		stopAllGenerations,
		cancelGeneration,
		submitMessage,
		continueMessage,
		siblingMessage,
		canOfferSiblingMessage,
	};
}
