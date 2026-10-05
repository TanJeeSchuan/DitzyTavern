// ==[HUMAN APPROVED]== Every SSE frame payload is a member of the shared Generation event
// vocabulary: normalized events, state snapshots, and the terminal applied/
// stopped/failure frames. The schemas in src/shared/contract/generation-events
// own the shapes; this adapter only owns framing and delivery.
import type {
	GenerationAttemptTarget,
	GenerationAppliedPayload,
	GenerationEvent,
	GenerationFailurePayload,
	GenerationStatePayload,
	GenerationStoppedPayload,
} from "../../shared/contract/generation-events";
import type {
	GenerationRuntime,
	GenerationRuntimeState,
} from "../workflows/generation-runtime";

type GenerationSsePayload =
	| GenerationEvent
	| GenerationStatePayload
	| GenerationAppliedPayload
	| GenerationStoppedPayload
	| GenerationFailurePayload;

const generationAttemptTarget = (state: GenerationRuntimeState): GenerationAttemptTarget => ({
	generationId: state.generationId,
	conversationId: state.conversationId,
	messageId: state.messageId,
	variantId: state.variantId,
});

const activeGenerationPayload = (state: GenerationRuntimeState): GenerationStatePayload => ({
	...generationAttemptTarget(state),
	outcome: "active-state",
	content: state.content,
	reasoning: state.reasoning,
	latestEventId: state.latestEventId,
	status: state.status,
	terminalReason: state.terminalReason,
	imageModel: state.imageModel,
});

type GenerationTerminalFrame =
	| { type: "complete"; data: GenerationAppliedPayload }
	| { type: "stopped"; data: GenerationStoppedPayload }
	| { type: "error"; data: GenerationFailurePayload };

const terminalGenerationFrame = (state: GenerationRuntimeState): GenerationTerminalFrame =>
	state.status === "complete"
		? {
			type: "complete",
			data: {
				...generationAttemptTarget(state),
				outcome: "applied" as const,
				latestEventId: state.latestEventId,
			},
		}
		: state.status === "stopped"
			? {
				type: "stopped",
				data: { ...generationAttemptTarget(state), outcome: "stopped" as const },
			}
			: {
				type: "error",
				data: {
					...generationAttemptTarget(state),
					outcome: "failed" as const,
					reason: state.terminalReason ?? "Generation failed.",
					imageModel: state.imageModel,
				},
			};

export function createGenerationSubscriptionResponse(
	runtime: GenerationRuntime,
	afterEventId: number,
	request: Request,
): Response {
	const encoder = new TextEncoder();
	const frame = (type: string, data: GenerationSsePayload, eventId?: number) =>
		`${eventId === undefined ? "" : `id: ${eventId}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let subscription: ReturnType<typeof runtime.subscribe> | undefined;
			let removeStateListener: (() => void) | undefined;
			let removeAbortListener: (() => void) | undefined;
			const cleanup = () => {
				subscription?.close();
				removeStateListener?.();
				removeAbortListener?.();
			};
			const emit = (type: string, data: GenerationSsePayload, eventId?: number) => {
				if (closed) return;
				try { controller.enqueue(encoder.encode(frame(type, data, eventId))); } catch { /* client disconnected ==[HUMAN APPROVED]== */ }
			};
			const finish = (state: GenerationRuntimeState) => {
				if (closed || state.status === "active") return;
				const terminal = terminalGenerationFrame(state);
				emit(terminal.type, terminal.data);
				closed = true;
				cleanup();
				try { controller.close(); } catch { /* client disconnected ==[HUMAN APPROVED]== */ }
			};
			const onAbort = () => {
				if (closed) return;
				closed = true;
				cleanup();
				try { controller.close(); } catch { /* client disconnected ==[HUMAN APPROVED]== */ }
			};
			removeStateListener = runtime.onStateChange(finish);
			subscription = runtime.subscribe(
				afterEventId,
				(envelope) => emit("generation", envelope.event, envelope.eventId),
				(state) => emit("state", activeGenerationPayload(state)),
			);
			// ==[HUMAN APPROVED]== A terminal runtime can synchronously finish from the replay callback
			// before subscribe() returns. Close the newly-created subscription too.
			if (closed) subscription.close();
			finish(runtime.state);
			removeAbortListener = () => request.signal.removeEventListener("abort", onAbort);
			if (closed) {
				removeAbortListener();
			} else if (request.signal.aborted) {
				onAbort();
			} else {
				request.signal.addEventListener("abort", onAbort, { once: true });
			}
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			connection: "keep-alive",
		},
	});
}
