import { useEffect, useReducer, useRef, useState, type RefObject } from "react";
import {
	previewConversationGeneration,
	startConversationContinuationGeneration,
	startConversationGeneration,
	startConversationSiblingGeneration,
	type ConversationSummary,
	type GenerationPreviewBody,
} from "../conversation";
import type { PromptPlan } from "../../shared/contract/conversation-schema";
import { canStartAssembly } from "../assembly";
import {
	isAssemblyPending,
	reduceAssemblySession,
	type AssemblySession,
} from "../assembly-session";

type GenerationStartLifecycle = {
	begin: () => number;
	settle: (startId: number) => void;
	accepted: (startId: number, generationId: number) => void;
};

type AssemblyControllerOptions = {
	conversation: ConversationSummary | null;
	activeChatIdRef: RefObject<string>;
	refreshStory: (conversationId: number) => Promise<ConversationSummary | null>;
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
	isGenerating,
	variantPreviewActive,
	inspectPromptPlanBeforeGenerating,
	generationStart,
	clearDraft,
}: AssemblyControllerOptions) {
	const [assembly, dispatchAssembly] = useReducer(reduceAssemblySession, null);
	const [directStartError, setDirectStartError] = useState<string | null>(null);
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
					error: outcome.status === "invalid" || outcome.status === "not-playable"
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

	const generationRequest = (
		conversationId: number,
		request: GenerationPreviewBody,
		preview?: { previewId: string; promptPlan: PromptPlan },
	) => {
		const formatting = { timeZone: request.timeZone, locale: request.locale };
		return request.kind === "send"
			? startConversationGeneration(conversationId, conversation!.revision, request.content, formatting, preview)
			: request.kind === "continuation"
				? startConversationContinuationGeneration(conversationId, conversation!.revision, formatting, preview)
				: startConversationSiblingGeneration(conversationId, request.messageId, formatting, preview);
	};

	const startGeneration = async (
		startId: number,
		conversationId: number,
		requestId: number,
		request: Promise<Awaited<ReturnType<typeof startConversationGeneration>>>,
		clearDraftOnAccepted: boolean,
		onFailure: (message: string) => void,
		onAccepted: () => void,
	) => {
		let outcome: Awaited<ReturnType<typeof startConversationGeneration>>;
		try {
			outcome = await request;
		} catch {
			if (!canApplyAssemblyEffect(requestId, conversationId)) return;
			generationStart.settle(startId);
			onFailure("Generation could not be started.");
			return;
		}
		if (!canApplyAssemblyEffect(requestId, conversationId)) return;
		if (outcome.outcome !== "accepted") {
			generationStart.settle(startId);
			onFailure(outcome.outcome === "not-found"
				? "The Conversation no longer exists."
				: (outcome.reason ?? "Generation could not be started."));
			return;
		}

		onAccepted();
		if (clearDraftOnAccepted) clearDraft();
		let freshConversation: ConversationSummary | null;
		try {
			freshConversation = await refreshStory(conversationId);
		} catch {
			if (!canApplyAssemblyEffect(requestId, conversationId)) return;
			generationStart.settle(startId);
			return;
		}
		if (!canApplyAssemblyEffect(requestId, conversationId)) return;
		if (
			freshConversation === null ||
			!freshConversation.activeGenerations.some(
				(generation) => generation.generationId === outcome.generationId,
			)
		) {
			generationStart.settle(startId);
		} else {
			generationStart.accepted(startId, outcome.generationId);
		}
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

	const requestGeneration = (request: GenerationPreviewBody) => {
		setDirectStartError(null);
		if (inspectPromptPlanBeforeGenerating) openPromptPlanPreview(request);
		else startWithoutPreview(request);
	};

	const conversationSwitched = () => {
		invalidateAssemblyRequests();
		setDirectStartError(null);
		dispatchAssembly({ type: "conversation-switched" });
	};

	const assemblyAvailable = canStartAssembly({
		playable: conversation?.playable === true,
		isGenerating,
		assemblyActive: assembly !== null,
		variantPreviewActive,
	});

	return {
		assembly,
		directStartError,
		assemblyAvailable,
		editPromptPlanPreview,
		refreshPromptPlanPreview,
		cancelPromptPlanPreview,
		sendPromptPlanPreview,
		requestGeneration,
		conversationSwitched,
	};
}
