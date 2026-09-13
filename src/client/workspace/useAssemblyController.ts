import { useEffect, useReducer, useRef, type RefObject } from "react";
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
	generationStart: GenerationStartLifecycle;
	clearDraft: () => void;
};

export function useAssemblyController({
	conversation,
	activeChatIdRef,
	refreshStory,
	isGenerating,
	variantPreviewActive,
	generationStart,
	clearDraft,
}: AssemblyControllerOptions) {
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
			generationStart.settle(startId);
			dispatchAssembly({
				type: "acceptance-failed",
				requestId: assemblyRequestId,
				error: "Generation could not be started.",
			});
			return;
		}
		if (!canApplyAssemblyEffect(assemblyRequestId, conversationId)) return;
		if (outcome.outcome !== "accepted") {
			generationStart.settle(startId);
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
		if (clearDraftOnAccepted) clearDraft();
		let freshConversation: ConversationSummary | null;
		try {
			freshConversation = await refreshStory(conversationId);
		} catch {
			if (!canApplyAssemblyEffect(assemblyRequestId, conversationId)) return;
			generationStart.settle(startId);
			return;
		}
		if (!canApplyAssemblyEffect(assemblyRequestId, conversationId)) return;
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
		const formatting = { timeZone: request.timeZone, locale: request.locale };
		const start = request.kind === "send"
			? startConversationGeneration(conversationId, conversation.revision, request.content, formatting, previewInput)
			: request.kind === "continuation"
			? startConversationContinuationGeneration(conversationId, conversation.revision, formatting, previewInput)
			: startConversationSiblingGeneration(conversationId, request.messageId, formatting, previewInput);
		void startGeneration(
			startId,
			conversationId,
			requestId,
			start,
			request.kind === "send",
		);
	};

	const conversationSwitched = () => {
		invalidateAssemblyRequests();
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
		assemblyAvailable,
		editPromptPlanPreview,
		refreshPromptPlanPreview,
		cancelPromptPlanPreview,
		sendPromptPlanPreview,
		openPromptPlanPreview,
		conversationSwitched,
	};
}
