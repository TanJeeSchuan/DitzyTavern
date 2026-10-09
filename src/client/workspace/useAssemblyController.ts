import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type RefObject } from "react";
import {
	previewConversationGeneration,
	startConversationContinuationGeneration,
	startConversationGeneration,
	startConversationSiblingGeneration,
	type ConversationSummary,
	type GenerationPreviewBody,
} from "../conversation";
import type { GenerationPreview, PromptPlan } from "../../shared/contract/conversation-schema";
import type { GenerationAttemptTarget } from "../../shared/contract/generation-events";
import { canStartAssembly } from "../assembly";
import { isAssemblyPending, type AssemblySession, type AssemblySessionPhase } from "../assembly-session";

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

type AssemblyRequest = { conversationId: number; request: GenerationPreviewBody };

type GenerationStartSubmission = {
	startId: number;
	conversationId: number;
	request: GenerationPreviewBody;
	clearDraft: boolean;
	preview?: { previewId: string; promptPlan: PromptPlan };
};

// @approved
//  The preview read and the Generation starts classify their own failure
//  wording; the transport returns typed outcomes and never rejects, so the
//  query and mutation seams throw the message the surface shows.
const loadPreview = async (request: AssemblyRequest, signal: AbortSignal): Promise<GenerationPreview> => {
	const outcome = await previewConversationGeneration(request.conversationId, request.request, signal);
	if (outcome.outcome === "available") return outcome.value;
	throw new Error(outcome.outcome === "invalid" || outcome.outcome === "unusable" || outcome.outcome === "not-playable"
		? outcome.reason
		: outcome.outcome === "not-found"
			? "The Conversation no longer exists."
			: "The Prompt Plan could not be assembled.");
};

/** @approved
 * Owns the Prompt Plan preview and acceptance: react-query holds the preview
 * read keyed by its request and the two Generation starts, while the panel
 * phase is derived from their fetch, pending, and error state.
 */
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
	const client = useQueryClient();
	const [assemblyRequest, setAssemblyRequest] = useState<AssemblyRequest | null>(null);
	const [preparing, setPreparing] = useState(false);
	const [directStartError, setDirectStartError] = useState<string | null>(null);
	const [acceptError, setAcceptError] = useState<string | null>(null);
	const [lastGeneration, setLastGeneration] = useState<AssemblyRequest | null>(null);

	const previewKey = ["assembly-preview", assemblyRequest] as const;
	const preview = useQuery({
		queryKey: previewKey,
		queryFn: assemblyRequest === null ? skipToken : ({ signal }) => loadPreview(assemblyRequest, signal),
	});

	const issueGeneration = async (submission: GenerationStartSubmission): Promise<GenerationAttemptTarget> => {
		const latest = await ensureLatest();
		if (latest === null || Number(activeChatIdRef.current) !== submission.conversationId) throw new Error("The Chat changed.");
		const formatting = { timeZone: submission.request.timeZone, locale: submission.request.locale };
		const outcome = submission.request.kind === "send"
			? await startConversationGeneration(submission.conversationId, latest.revision, submission.request.content, formatting, submission.preview)
			: submission.request.kind === "continuation"
				? await startConversationContinuationGeneration(submission.conversationId, latest.revision, formatting, submission.preview)
				: await startConversationSiblingGeneration(submission.conversationId, submission.request.messageId, formatting, submission.preview);
		if (outcome.outcome === "available") return outcome.value;
		throw new Error(outcome.outcome === "not-found"
			? "The Conversation no longer exists."
			: outcome.outcome === "network"
				? "Generation could not be started."
				: outcome.reason);
	};

	// @approved
	//  Acceptance and a direct start settle through the same completion: the
	//  accepted target is only reported to the session machine while the Chat
	//  that started it is still active, and the story refresh never blocks it.
	const finishStart = (submission: GenerationStartSubmission, target: GenerationAttemptTarget, closeAssembly: boolean) => {
		if (Number(activeChatIdRef.current) !== submission.conversationId) return;
		if (closeAssembly) setAssemblyRequest(null);
		if (submission.clearDraft) clearDraft();
		void refreshStory(submission.conversationId).catch(() => null).then(() => {
			if (Number(activeChatIdRef.current) === submission.conversationId) generationStart.accepted(submission.startId, target);
		});
	};
	const startDirect = useMutation({
		mutationKey: ["assembly", "start"],
		mutationFn: issueGeneration,
		onSuccess: (target, submission) => finishStart(submission, target, false),
		onError: (error, submission) => {
			if (Number(activeChatIdRef.current) !== submission.conversationId) return;
			generationStart.settle(submission.startId);
			setDirectStartError(error.message);
		},
	});
	const accept = useMutation({
		mutationKey: ["assembly", "accept"],
		mutationFn: issueGeneration,
		onSuccess: (target, submission) => finishStart(submission, target, true),
		onError: (error, submission) => {
			if (Number(activeChatIdRef.current) !== submission.conversationId) return;
			generationStart.settle(submission.startId);
			setAcceptError(error.message);
		},
	});

	const previewError = preview.isFetching ? null : preview.error?.message ?? null;
	const phase: AssemblySessionPhase = accept.isPending ? "accepting"
		: preview.isFetching ? "assembling"
			: previewError !== null || acceptError !== null ? "failed"
				: preview.data === undefined ? "assembling" : "ready";
	const assembly: AssemblySession | null = assemblyRequest === null ? null : {
		phase,
		preview: preview.data ?? null,
		error: previewError ?? acceptError,
	};

	const openPromptPlanPreview = (request: GenerationPreviewBody) => {
		if (conversation === null || assemblyRequest !== null) return;
		setAcceptError(null);
		setAssemblyRequest({ conversationId: conversation.id, request });
	};

	const refreshPromptPlanPreview = () => {
		if (assembly === null || isAssemblyPending(assembly)) return;
		setAcceptError(null);
		void preview.refetch();
	};

	const cancelPromptPlanPreview = () => {
		if (assembly === null || assembly.phase === "accepting") return;
		setAcceptError(null);
		setAssemblyRequest(null);
		void client.cancelQueries({ queryKey: ["assembly-preview"] });
	};

	const editPromptPlanPreview = (promptPlan: PromptPlan) => {
		if (assemblyRequest === null) return;
		client.setQueryData<GenerationPreview>(previewKey, (current) => current === undefined ? current : { ...current, promptPlan });
	};

	const sendPromptPlanPreview = () => {
		const currentPreview = preview.data;
		if (assemblyRequest === null || currentPreview === undefined || (phase !== "ready" && phase !== "failed")) return;
		const { conversationId, request } = assemblyRequest;
		const startId = generationStart.begin();
		setAcceptError(null);
		setLastGeneration({ conversationId, request });
		accept.mutate({
			startId,
			conversationId,
			request,
			clearDraft: request.kind === "send",
			preview: { previewId: currentPreview.previewId, promptPlan: currentPreview.promptPlan },
		});
	};

	const startWithoutPreview = (request: GenerationPreviewBody) => {
		if (conversation === null || assemblyRequest !== null) return;
		const conversationId = conversation.id;
		const startId = generationStart.begin();
		setDirectStartError(null);
		setLastGeneration({ conversationId, request });
		startDirect.mutate({ startId, conversationId, request, clearDraft: request.kind === "send" });
	};

	const requestGeneration = (request: GenerationPreviewBody) => {
		if (preparing || conversation === null) return;
		const conversationId = conversation.id;
		setPreparing(true);
		setDirectStartError(null);
		void ensureLatest().then(() => {
			if (Number(activeChatIdRef.current) !== conversationId) return;
			if (inspectPromptPlanBeforeGenerating) openPromptPlanPreview(request);
			else startWithoutPreview(request);
		}).catch(() => setDirectStartError("The latest Messages could not be loaded.")).finally(() => setPreparing(false));
	};

	const canRetry = conversation !== null && lastGeneration?.conversationId === conversation.id &&
		assemblyRequest === null && !variantPreviewActive && !isGenerating;

	const retryLastGeneration = () => {
		if (!canRetry || lastGeneration === null) return;
		requestGeneration(lastGeneration.request);
	};

	const conversationSwitched = () => {
		setLastGeneration(null);
		setDirectStartError(null);
		setAcceptError(null);
		setAssemblyRequest(null);
		void client.cancelQueries({ queryKey: ["assembly-preview"] });
	};

	const assemblyAvailable = canStartAssembly({
		playable: conversation?.playable === true,
		isGenerating: isGenerating || preparing,
		assemblyActive: assemblyRequest !== null,
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
