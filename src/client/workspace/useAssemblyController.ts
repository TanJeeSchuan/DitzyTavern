import { useEffect, useReducer, useRef, useState, type RefObject } from "react";
import {
	previewConversationGeneration,
	startConversationContinuationGeneration,
	startConversationGeneration,
	startConversationSiblingGeneration,
	type ConversationSummary,
	type GenerationPreviewBody,
	type GenerationStartResult,
} from "../conversation";
import type { PromptPlan } from "../../shared/contract/conversation-schema";
import type { GenerationAttemptTarget } from "../../shared/contract/generation-events";
import { canStartAssembly } from "../assembly";
import {
	isAssemblyPending,
	reduceAssemblySession,
	type AssemblySession,
} from "../assembly-session";

type GenerationStartLifecycle = {
	begin: () => number;
	settle: (startId: number) => void;
	accepted: (startId: number, target: GenerationAttemptTarget) => void;
};

type AssemblyControllerOptions = {
	conversation: ConversationSummary | null;
	activeChatIdRef: RefObject<string>;
	refreshStory: (conversationId: number) => Promise<ConversationSummary | null>;
	ensureLatest: () => Promise<ConversationSummary | null>;
	isGenerating: boolean;
	variantPreviewActive: boolean;
	inspectPromptPlanBeforeGenerating: boolean;
	generationStart: GenerationStartLifecycle;
	clearDraft: () => void;
};

export function useAssemblyController({
	conversation,
	activeChatIdRef,
	refreshStory,
	ensureLatest,
	isGenerating,
	variantPreviewActive,
	inspectPromptPlanBeforeGenerating,
	generationStart,
	clearDraft,
}: AssemblyControllerOptions) {
	const [assembly, dispatchAssembly] = useReducer(reduceAssemblySession, null);
	const [preparing, setPreparing] = useState(false);
	const preparingRef = useRef(false);
	const [directStartError, setDirectStartError] = useState<string | null>(null);
	const nextAssemblyRequestIdRef = useRef(1);
	const assemblyMountedRef = useRef(true);
	const lastGenerationRef = useRef<{
		conversationId: number;
		request: GenerationPreviewBody;
	} | null>(null);

	const canRetry = conversation !== null && lastGenerationRef.current?.conversationId === conversation.id &&
		assembly === null && !variantPreviewActive && !isGenerating;

	// @approved
	//  Assembly request identity is one monotonic counter: a request stays
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

	useEffect(() => {
		assemblyMountedRef.current = true;
		return () => {
			assemblyMountedRef.current = false;
		};
	}, []);

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
			requestId,
			request,
			preview: preservedPreview,
		});
		// @approved
		//  The transport classifies every failure itself; it never rejects.
		void previewConversationGeneration(conversationId, request)
			.then((outcome) => {
				if (!canApplyAssemblyEffect(requestId, conversationId)) return;
				if (outcome.outcome === "available") {
					dispatchAssembly({ type: "preview-available", requestId, preview: outcome.value });
					return;
				}
				dispatchAssembly({
					type: "preview-failed",
					requestId,
					error: outcome.outcome === "invalid" || outcome.outcome === "unusable" || outcome.outcome === "not-playable"
						? outcome.reason
						: outcome.outcome === "not-found"
							? "The Conversation no longer exists."
							: "The Prompt Plan could not be assembled.",
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

	const generationRequest = async (
		conversationId: number,
		request: GenerationPreviewBody,
		preview?: { previewId: string; promptPlan: PromptPlan },
	) => {
		const latest = await ensureLatest();
		if (latest === null || Number(activeChatIdRef.current) !== conversationId) throw new Error("The Chat changed.");
		const formatting = { timeZone: request.timeZone, locale: request.locale };
		return request.kind === "send"
			? startConversationGeneration(conversationId, latest.revision, request.content, formatting, preview)
			: request.kind === "continuation"
				? startConversationContinuationGeneration(conversationId, latest.revision, formatting, preview)
				: startConversationSiblingGeneration(conversationId, request.messageId, formatting, preview);
	};

	const startGeneration = async (
		startId: number,
		conversationId: number,
		requestId: number,
		request: Promise<GenerationStartResult>,
		clearDraftOnAccepted: boolean,
		onFailure: (message: string) => void,
		onAccepted: () => void,
	) => {
		// @approved
		//  The transport classifies every failure itself; it never rejects.
		const outcome = await request;
		if (!canApplyAssemblyEffect(requestId, conversationId)) return;
		if (outcome.outcome !== "available") {
			generationStart.settle(startId);
			onFailure(outcome.outcome === "not-found"
				? "The Conversation no longer exists."
				: outcome.outcome === "network"
					? "Generation could not be started."
					: outcome.reason);
			return;
		}

		onAccepted();
		if (clearDraftOnAccepted) clearDraft();
		await refreshStory(conversationId).catch(() => null);
		if (!canApplyAssemblyEffect(requestId, conversationId)) return;
		generationStart.accepted(startId, outcome.value);
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
		const startId = generationStart.begin();
		dispatchAssembly({ type: "acceptance-started", requestId });
		const previewInput = { previewId: preview.previewId, promptPlan: preview.promptPlan };
		lastGenerationRef.current = { conversationId, request };
		void startGeneration(
			startId,
			conversationId,
			requestId,
			generationRequest(conversationId, request, previewInput),
			request.kind === "send",
			(error) => dispatchAssembly({ type: "acceptance-failed", requestId, error }),
			() => dispatchAssembly({ type: "acceptance-succeeded", requestId }),
		);
	};

	const startWithoutPreview = (request: GenerationPreviewBody) => {
		if (conversation === null || assembly !== null) return;
		const conversationId = conversation.id;
		const requestId = issueAssemblyRequestId();
		const startId = generationStart.begin();
		setDirectStartError(null);
		lastGenerationRef.current = { conversationId, request };
		void startGeneration(
			startId,
			conversationId,
			requestId,
			generationRequest(conversationId, request),
			request.kind === "send",
			setDirectStartError,
			() => undefined,
		);
	};

	const retryLastGeneration = () => {
		if (!canRetry) return;
		const lastGeneration = lastGenerationRef.current;
		if (conversation === null || lastGeneration === null || lastGeneration.conversationId !== conversation.id) return;
		requestGeneration(lastGeneration.request);
	};

	const requestGeneration = (request: GenerationPreviewBody) => {
		if (preparingRef.current || conversation === null) return;
		const conversationId = conversation.id;
		preparingRef.current = true;
		setPreparing(true);
		setDirectStartError(null);
		void ensureLatest().then(() => {
			if (!assemblyMountedRef.current || Number(activeChatIdRef.current) !== conversationId) return;
			if (inspectPromptPlanBeforeGenerating) openPromptPlanPreview(request);
			else startWithoutPreview(request);
		}).catch(() => setDirectStartError("The latest Messages could not be loaded.")).finally(() => {
			preparingRef.current = false;
			setPreparing(false);
		});
	};

	const conversationSwitched = () => {
		lastGenerationRef.current = null;
		invalidateAssemblyRequests();
		setDirectStartError(null);
		dispatchAssembly({ type: "conversation-switched" });
	};

	const assemblyAvailable = canStartAssembly({
		playable: conversation?.playable === true,
		isGenerating: isGenerating || preparing,
		assemblyActive: assembly !== null,
		variantPreviewActive,
	});

	return {
		assembly,
		directStartError,
		acknowledgeDirectStartError: () => setDirectStartError(null),
		assemblyAvailable,
		editPromptPlanPreview,
		refreshPromptPlanPreview,
		cancelPromptPlanPreview,
		sendPromptPlanPreview,
		requestGeneration,
		retryGeneration: canRetry ? retryLastGeneration : null,
		conversationSwitched,
	};
}
