import type { ModelClientEvent } from "../model-client";
import type {
	GenerationRuntime,
	GenerationRuntimeState,
} from "../workflows/generation-runtime";

type GenerationSsePayload =
	| ModelClientEvent
	| { readonly outcome: "applied"; readonly generationId?: number; readonly latestEventId?: number }
	| { readonly outcome: "failed"; readonly reason: string }
	| { readonly outcome: "stopped"; readonly generationId: number }
	| {
			readonly outcome: "active-state";
			readonly generationId: number;
			readonly conversationId: number;
			readonly messageId: number;
			readonly variantId: number;
			readonly content: string;
			readonly reasoning: string;
			readonly latestEventId: number;
			readonly status: "active" | "complete" | "stopped" | "failed";
			readonly terminalReason: string | null;
		};

const activeGenerationPayload = (state: GenerationRuntimeState) => ({
	outcome: "active-state" as const,
	generationId: state.generationId,
	conversationId: state.conversationId,
	messageId: state.messageId,
	variantId: state.variantId,
	content: state.content,
	reasoning: state.reasoning,
	latestEventId: state.latestEventId,
	status: state.status,
	terminalReason: state.terminalReason,
});

const terminalGenerationFrame = (state: GenerationRuntimeState) =>
	state.status === "complete"
		? {
			type: "complete",
			data: {
				outcome: "applied" as const,
				generationId: state.generationId,
				latestEventId: state.latestEventId,
			},
		}
		: state.status === "stopped"
			? {
				type: "stopped",
				data: { outcome: "stopped" as const, generationId: state.generationId },
			}
			: {
				type: "error",
				data: { outcome: "failed" as const, reason: state.terminalReason ?? "Generation failed." },
			};

export function createGenerationSubscriptionResponse(
	runtime: GenerationRuntime,
	afterEventId: number,
	request: Request,
	onClosed?: () => void,
): Response {
	const encoder = new TextEncoder();
	const frame = (type: string, data: GenerationSsePayload, eventId?: number) =>
		`${eventId === undefined ? "" : `id: ${eventId}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			let closed = false;
			let subscription: ReturnType<typeof runtime.subscribe> | undefined;
			let removeStateListener: (() => void) | undefined;
			const emit = (type: string, data: GenerationSsePayload, eventId?: number) => {
				if (closed) return;
				try { controller.enqueue(encoder.encode(frame(type, data, eventId))); } catch { /* client disconnected */ }
			};
			const finish = (state: GenerationRuntimeState) => {
				if (closed || state.status === "active") return;
				subscription?.close();
				removeStateListener?.();
				const terminal = terminalGenerationFrame(state);
				emit(terminal.type, terminal.data);
				closed = true;
				try { controller.close(); } catch { /* client disconnected */ }
				onClosed?.();
			};
			subscription = runtime.subscribe(
				afterEventId,
				(envelope) => emit("generation", envelope.event, envelope.eventId),
				(state) => emit("state", activeGenerationPayload(state)),
			);
			removeStateListener = runtime.onStateChange(finish);
			finish(runtime.state);
			request.signal.addEventListener("abort", () => {
				if (closed) return;
				closed = true;
				subscription?.close();
				removeStateListener?.();
				onClosed?.();
			}, { once: true });
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
