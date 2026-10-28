// @approved
//  Every SSE frame payload is a member of the shared Generation event
// vocabulary: normalized events, state snapshots, and the terminal applied/
// stopped/failure frames. The schemas in src/shared/contract/generation-events
// own the shapes; this adapter maps runtime state to delivery frames.
import { sse, type Context } from "elysia";
import { subscriptionEvents } from "./subscription-events";
import type {
	GenerationAttemptTarget,
	GenerationAppliedPayload,
	GenerationFailurePayload,
	GenerationStatePayload,
	GenerationStoppedPayload,
} from "../../shared/contract/generation-events";
import type {
	GenerationRuntime,
	GenerationRuntimeState,
} from "../workflows/generation-runtime";

const generationAttemptTarget = (state: GenerationRuntimeState): GenerationAttemptTarget => ({
	generationId: state.generationId,
	conversationId: state.conversationId,
	messageId: state.messageId,
	variantId: state.variantId,
});

const activeGenerationPayload = ({ startedAt: _startedAt, ...state }: GenerationRuntimeState): GenerationStatePayload => ({
	...state,
	outcome: "active-state",
});

type GenerationTerminalFrame =
	| { event: "complete"; data: GenerationAppliedPayload }
	| { event: "stopped"; data: GenerationStoppedPayload }
	| { event: "error"; data: GenerationFailurePayload };

const terminalGenerationFrame = (state: GenerationRuntimeState): GenerationTerminalFrame => {
	switch (state.status) {
		case "active": throw new Error(`Generation ${state.generationId} is active and has no terminal frame.`);
		case "complete": return {
			event: "complete",
			data: { ...generationAttemptTarget(state), outcome: "applied", latestEventId: state.latestEventId },
		};
		case "stopped": return { event: "stopped", data: { ...generationAttemptTarget(state), outcome: "stopped" } };
		case "failed": return {
			event: "error",
			data: { ...generationAttemptTarget(state), outcome: "failed", reason: state.reason, imageModel: state.imageModel },
		};
	}
};

export function generationSubscriptionEvents(
	runtime: GenerationRuntime,
	afterEventId: number,
	context: Pick<Context, "request" | "set">,
) {
	return subscriptionEvents(context, (emit, close) => {
		const finish = (state: GenerationRuntimeState) => {
			if (state.status === "active") return;
			emit(sse(terminalGenerationFrame(state)));
			close();
		};
		const removeStateListener = runtime.onStateChange(finish);
		const subscription = runtime.subscribe(
			afterEventId,
			(envelope) => emit(sse({ event: "generation", data: envelope.event, id: envelope.eventId })),
			(state) => emit(sse({ event: "state", data: activeGenerationPayload(state) })),
		);
		finish(runtime.state);
		return () => { subscription.close(); removeStateListener(); };
	});
}
