import type { GenerationPreviewBody } from "./conversation";

// @approved
//  `seat` is the human seat the request was made from, which its seat-bound Moves belong to.
export type StartRequest = { conversationId: number; seat: number | null; versions: Readonly<Record<string, string>>; request: GenerationPreviewBody };

/** @approved
 * One Generation start, from the request to the server's answer. Once accepted, the pending starts hold the start until its session is observed.
 * `last` is the request most recently sent, offered again as a retry.
 */
export type GenerationStart = { visit: AbortSignal; last: StartRequest | null } & (
	// @approved
	//  `error` is why the last direct start, or the preparation of any start, failed.
	| { phase: "idle"; error: string | null }
	| { phase: "preparing"; request: StartRequest }
	| { phase: "inspecting"; request: StartRequest; acceptance: { status: "open" | "accepting" } | { status: "failed"; error: string } }
	| { phase: "starting" }
);

// @approved
//  Every event names the visit it belongs to: an event from an ended visit changes nothing.
export type GenerationStartEvent = { visit: AbortSignal } & (
	| { type: "requested"; request: StartRequest }
	| { type: "prepared"; inspect: boolean }
	| { type: "accepting" }
	| { type: "start-accepted" }
	| { type: "failed"; error: string }
	| { type: "cancelled" }
	| { type: "preview-refreshed" }
	| { type: "error-acknowledged" }
);

const idle = (visit: AbortSignal, last: StartRequest | null, error: string | null = null): GenerationStart => ({ visit, last, phase: "idle", error });

/** @approved A start belongs to the visit it began in; any other visit sees an idle start with nothing to retry. */
export const generationStartAt = (state: GenerationStart, visit: AbortSignal): GenerationStart => state.visit === visit ? state : idle(visit, null);

const transition = (state: GenerationStart, event: GenerationStartEvent): GenerationStart => {
	const { visit, last } = state;
	switch (event.type) {
		case "requested":
			return state.phase === "idle" ? { visit, last, phase: "preparing", request: event.request } : state;
		case "prepared":
			if (state.phase !== "preparing") return state;
			return event.inspect ? { visit, last, phase: "inspecting", request: state.request, acceptance: { status: "open" } } : { visit, last: state.request, phase: "starting" };
		case "accepting":
			return state.phase === "inspecting" && state.acceptance.status !== "accepting" ? { ...state, last: state.request, acceptance: { status: "accepting" } } : state;
		case "start-accepted":
			return state.phase === "starting" || (state.phase === "inspecting" && state.acceptance.status === "accepting") ? idle(visit, last) : state;
		case "failed":
			if (state.phase === "inspecting") return state.acceptance.status === "accepting" ? { ...state, acceptance: { status: "failed", error: event.error } } : state;
			return state.phase === "preparing" || state.phase === "starting" ? idle(visit, last, event.error) : state;
		case "cancelled":
			return state.phase === "preparing" || (state.phase === "inspecting" && state.acceptance.status !== "accepting") ? idle(visit, last) : state;
		case "preview-refreshed":
			return state.phase === "inspecting" && state.acceptance.status === "failed" ? { ...state, acceptance: { status: "open" } } : state;
		case "error-acknowledged":
			return state.phase === "idle" && state.error !== null ? idle(visit, last) : state;
	}
};

export function reduceGenerationStart(state: GenerationStart, event: GenerationStartEvent): GenerationStart {
	if (event.visit.aborted || (event.type !== "requested" && event.visit !== state.visit)) return state;
	const current = generationStartAt(state, event.visit);
	const next = transition(current, event);
	return next === current ? state : next;
}
