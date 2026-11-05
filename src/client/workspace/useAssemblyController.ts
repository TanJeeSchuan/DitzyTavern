import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore, type Dispatch, type RefObject } from "react";
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
import { store } from "../lib/store";
import { useConversationVisit } from "../lib/visit";
import { hasMoves, pickMoves, seatBound } from "../../shared/contract/box-generation";
import { chatBoxDescriptor } from "../box-windows/registry";
import { queueConversationCommand } from "../conversation-command-runner";
import type { StoryAction } from "../story";
import { isAssemblyPending, type AssemblySession, type AssemblySessionPhase } from "../assembly-session";
import { generationStartAt, reduceGenerationStart, type GenerationStart, type GenerationStartEvent, type StartRequest } from "../generation-start";

type GenerationStartLifecycle = {
	begin: () => number;
	settle: (startId: number) => void;
	accepted: (startId: number, target: GenerationAttemptTarget) => void;
};

type AssemblyControllerOptions = {
	signal: AbortSignal;
	conversation: ConversationSummary | null;
	activeChatIdRef: RefObject<string>;
	refreshStory: (conversationId: number, signal?: AbortSignal) => Promise<ConversationSummary | null>;
	ensureLatest: () => Promise<ConversationSummary | null>;
	isGenerating: boolean;
	variantPreviewActive: boolean;
	inspectPromptPlanBeforeGenerating: boolean;
	generationStart: GenerationStartLifecycle;
	dispatchStory: Dispatch<StoryAction>;
	// @approved
	//  Empties the composer for a Send and returns how to put its text and staged Moves back if the Send fails while its visit is current.
	takeComposer: () => () => void;
};

// The accepted target and the revision its start was sent on; acceptance always lands on a later one.
type AcceptedStart = { target: GenerationAttemptTarget; sentRevision: number };

type GenerationStartSubmission = StartRequest & {
	signal: AbortSignal;
	preview?: { previewId: string; promptPlan: PromptPlan } | undefined;
};

// @approved
//  The preview read and the Generation starts classify their own failure
//  wording; the transport returns typed outcomes and never rejects, so the
//  query and mutation seams throw the message the surface shows.
const loadPreview = async (request: StartRequest, signal: AbortSignal): Promise<GenerationPreview> => {
	const outcome = await previewConversationGeneration(request.conversationId, request.request, signal);
	if (outcome.outcome === "available") return outcome.value;
	throw new Error(outcome.outcome === "invalid" || outcome.outcome === "unusable" || outcome.outcome === "not-playable"
		? outcome.reason
		: outcome.outcome === "not-found"
			? "The Conversation no longer exists."
			: "The Prompt Plan could not be assembled.");
};

/** @approved
 * Owns a Generation start: the generation-start reducer holds its phase, react-query holds the Prompt Plan preview read
 * keyed by its request, and the story and pending starts hear of each start, acceptance and failure the reducer allows.
 */
export function useAssemblyController({
	signal: selection,
	conversation,
	activeChatIdRef,
	refreshStory,
	ensureLatest,
	isGenerating,
	variantPreviewActive,
	inspectPromptPlanBeforeGenerating,
	generationStart,
	dispatchStory,
	takeComposer,
}: AssemblyControllerOptions) {
	const client = useQueryClient();
	const signal = useConversationVisit(selection, conversation?.id);
	// @approved
	//  A store rather than state: a second call in the same tick must see the transition the first one made.
	const [machine] = useState(() => store<GenerationStart>({ visit: signal, last: null, phase: "idle", error: null }));
	const start = generationStartAt(useSyncExternalStore(machine.subscribe, machine.get), signal);
	const transition = (event: GenerationStartEvent) => {
		const previous = machine.get();
		machine.set(reduceGenerationStart(previous, event));
		return machine.get() !== previous;
	};
	const inspecting = start.phase === "inspecting" ? start : null;
	const assemblyRequest = inspecting?.request ?? null;

	const previewKey = ["assembly-preview", assemblyRequest] as const;
	const preview = useQuery({
		queryKey: previewKey,
		queryFn: assemblyRequest === null ? skipToken : ({ signal }) => loadPreview(assemblyRequest, signal),
		staleTime: Infinity,
		refetchOnReconnect: false,
	});

	const startGeneration = async (submission: GenerationStartSubmission, previous: number | null): Promise<AcceptedStart> => {
		submission.signal.throwIfAborted();
		const latest = await ensureLatest();
		submission.signal.throwIfAborted();
		if (latest === null || Number(activeChatIdRef.current) !== submission.conversationId) throw new Error("The Chat changed.");
		// @approved
		//  A seat change queued ahead of this start applied first: its seat-bound Moves would be sent as the new seat's.
		if (submission.request.kind === "send" && latest.control.humanParticipantId !== submission.seat && hasMoves(pickMoves(submission.request.moves ?? {}, (id) => seatBound(chatBoxDescriptor(latest, id))))) {
			throw new Error("The writer changed before this Send went out, so it was not sent.");
		}
		const revision = Math.max(latest.revision, previous ?? 0);
		const formatting = { timeZone: submission.request.timeZone, locale: submission.request.locale };
		const outcome = submission.request.kind === "send"
			? await startConversationGeneration(submission.conversationId, revision, submission.request.content, submission.request.moves, formatting, submission.preview, submission.signal)
			: submission.request.kind === "continuation"
				? await startConversationContinuationGeneration(submission.conversationId, revision, formatting, submission.preview, submission.signal)
				: await startConversationSiblingGeneration(submission.conversationId, submission.request.messageId, formatting, submission.preview, submission.signal, submission.request.reroll);
		submission.signal.throwIfAborted();
		if (outcome.outcome === "available") return { target: outcome.value, sentRevision: revision };
		throw new Error(outcome.outcome === "not-found"
			? "The Conversation no longer exists."
			: outcome.outcome === "network"
				? "Generation could not be started."
				: outcome.reason);
	};
	// A start waits its turn behind the Conversation commands already queued, so it builds on what they changed.
	const issueGeneration = async (submission: GenerationStartSubmission): Promise<AcceptedStart> => {
		const started = Promise.withResolvers<AcceptedStart>();
		await queueConversationCommand(submission.conversationId, async (previous) => {
			const attempt = startGeneration(submission, previous);
			attempt.then(started.resolve, started.reject);
			await attempt;
			return null;
		});
		return started.promise;
	};

	// @approved
	//  A direct start and a preview acceptance launch the same way once the
	//  reducer lets them. The accepted target is only reported while the visit
	//  that started it is current. It subscribes before the story refresh
	//  lands, and the story holds the output it streams until the refresh
	//  places its Variant.
	const launch = (request: StartRequest, preview?: GenerationStartSubmission["preview"]) => {
		const startId = generationStart.begin();
		dispatchStory({ type: "generation-requested", request: request.request });
		const restoreComposer = request.request.kind === "send" ? takeComposer() : undefined;
		issueGeneration({ ...request, signal, preview }).then(({ target, sentRevision }) => {
			if (!transition({ type: "start-accepted", visit: signal })) return;
			dispatchStory({ type: "generation-request-accepted", generationId: target.generationId, variantId: target.variantId, sentRevision });
			generationStart.accepted(startId, target);
			void refreshStory(request.conversationId, signal).catch(() => null);
		}, (error: Error) => {
			if (!transition({ type: "failed", visit: signal, error: error.message })) return;
			restoreComposer?.();
			generationStart.settle(startId);
			dispatchStory({ type: "generation-request-failed" });
		});
	};

	const previewError = preview.isFetching ? null : preview.error?.message ?? null;
	const acceptance = inspecting?.acceptance;
	const acceptError = acceptance?.status === "failed" ? acceptance.error : null;
	const phase: AssemblySessionPhase = acceptance?.status === "accepting" ? "accepting"
		: preview.isFetching ? "assembling"
			: previewError !== null || acceptError !== null ? "failed"
				: preview.data === undefined ? "assembling" : "ready";
	const assembly: AssemblySession | null = inspecting === null ? null : {
		phase,
		preview: preview.data ?? null,
		error: previewError ?? acceptError,
	};

	const refreshPromptPlanPreview = () => {
		if (assembly === null || isAssemblyPending(assembly)) return;
		transition({ type: "preview-refreshed", visit: signal });
		void preview.refetch();
	};

	const cancelPromptPlanPreview = () => {
		if (!transition({ type: "cancelled", visit: signal })) return;
		void client.cancelQueries({ queryKey: ["assembly-preview"] });
	};

	const editPromptPlanPreview = (promptPlan: PromptPlan) => {
		if (assemblyRequest === null) return;
		client.setQueryData<GenerationPreview>(previewKey, (current) => current === undefined ? current : { ...current, promptPlan });
	};

	const sendPromptPlanPreview = () => {
		const current = preview.data;
		if (inspecting === null || current === undefined || (phase !== "ready" && phase !== "failed")) return;
		if (!transition({ type: "accepting", visit: signal })) return;
		launch(inspecting.request, { previewId: current.previewId, promptPlan: current.promptPlan });
	};

	const requestGeneration = (request: GenerationPreviewBody, seat = conversation?.control.humanParticipantId ?? null) => {
		if (conversation === null) return;
		const requested = { conversationId: conversation.id, seat, request };
		if (!transition({ type: "requested", visit: signal, request: requested })) return;
		const inspect = inspectPromptPlanBeforeGenerating;
		void ensureLatest().then(() => {
			if (Number(activeChatIdRef.current) !== requested.conversationId) return void transition({ type: "cancelled", visit: signal });
			if (!transition({ type: "prepared", visit: signal, inspect })) return;
			if (inspect) client.removeQueries({ queryKey: ["assembly-preview"] });
			else launch(requested);
		}, () => transition({ type: "failed", visit: signal, error: "The latest Messages could not be loaded." }));
	};

	const retry = conversation !== null && start.phase === "idle" && !variantPreviewActive && !isGenerating ? start.last : null;

	return {
		assembly,
		directStartError: start.phase === "idle" ? start.error : null,
		acknowledgeDirectStartError: () => void transition({ type: "error-acknowledged", visit: signal }),
		assemblyAvailable: canStartAssembly({
			playable: conversation?.playable === true,
			isGenerating,
			assemblyActive: start.phase !== "idle",
			variantPreviewActive,
		}),
		editPromptPlanPreview,
		refreshPromptPlanPreview,
		cancelPromptPlanPreview,
		sendPromptPlanPreview,
		requestGeneration,
		retryGeneration: retry === null ? null : () => requestGeneration(retry.request, retry.seat),
	};
}
