import { Type, type Static } from "@sinclair/typebox";
import type { GenerationFailure, GenerationFailureKind, GenerationFinishReason } from "./generation-events";

export const terminalOutcome = Type.Union([
	Type.Literal("complete"),
	Type.Literal("length-limited"),
	Type.Literal("interrupted"),
]);

export type TerminalOutcome = Static<typeof terminalOutcome>;

export interface GenerationRuntimeFailure extends GenerationFailure {
	readonly kind?: GenerationFailureKind;
	readonly responseBody?: string;
}

export type RuntimeOutcome =
	| { readonly status: "complete"; readonly finishReason?: GenerationFinishReason }
	| { readonly status: "failed"; readonly failure: GenerationRuntimeFailure }
	| { readonly status: "stopped" };

export function durableOutcome(outcome: RuntimeOutcome): TerminalOutcome {
	switch (outcome.status) {
		case "complete": return outcome.finishReason === "length" ? "length-limited" : "complete";
		case "failed":
		case "stopped": return "interrupted";
	}
}

type ProviderOutcome = Exclude<RuntimeOutcome, { status: "stopped" }>;

export type GenerationPhase =
	| { readonly kind: "active" }
	| { readonly kind: "stopping"; readonly parked?: ProviderOutcome }
	| { readonly kind: "terminal"; readonly outcome: RuntimeOutcome; readonly at: number };

export type GenerationPhaseEvent =
	| { readonly type: "request-stop" }
	| { readonly type: "release-stop" }
	| { readonly type: "commit-stop" }
	| { readonly type: "provider-terminal"; readonly outcome: ProviderOutcome };

export function step(phase: GenerationPhase, event: GenerationPhaseEvent & { readonly at: number }): GenerationPhase {
	if (phase.kind === "terminal") return phase;
	switch (event.type) {
		case "request-stop": return phase.kind === "active" ? { kind: "stopping" } : phase;
		case "release-stop":
			return phase.kind !== "stopping" ? phase : phase.parked === undefined
				? { kind: "active" }
				: { kind: "terminal", outcome: phase.parked, at: event.at };
		case "commit-stop": return { kind: "terminal", outcome: { status: "stopped" }, at: event.at };
		case "provider-terminal":
			return phase.kind === "stopping"
				? { kind: "stopping", parked: phase.parked ?? event.outcome }
				: { kind: "terminal", outcome: event.outcome, at: event.at };
	}
}
