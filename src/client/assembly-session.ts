import type {
	GenerationPreview,
	GenerationPreviewBody,
	PromptPlan,
} from "../shared/contract/conversation-schema";

export type AssemblySessionPhase = "assembling" | "ready" | "accepting" | "failed";

export type AssemblySession = {
	phase: AssemblySessionPhase;
	requestId: number;
	request: GenerationPreviewBody;
	preview: GenerationPreview | null;
	error: string | null;
};

export type AssemblySessionAction =
	| {
			type: "started";
			requestId: number;
			request: GenerationPreviewBody;
			preview?: GenerationPreview | null;
		}
	| { type: "preview-available"; requestId: number; preview: GenerationPreview }
	| { type: "preview-failed"; requestId: number; error: string }
	| { type: "acceptance-started"; requestId: number }
	| { type: "acceptance-succeeded"; requestId: number }
	| { type: "acceptance-failed"; requestId: number; error: string }
	| { type: "plan-edited"; requestId: number; promptPlan: PromptPlan }
	| { type: "cancelled"; requestId: number }
	| { type: "conversation-switched" };

const ownsRequest = (session: AssemblySession | null, requestId: number): session is AssemblySession =>
	session !== null && session.requestId === requestId;

export function reduceAssemblySession(
	session: AssemblySession | null,
	action: AssemblySessionAction,
): AssemblySession | null {
	switch (action.type) {
		case "started":
			return {
				phase: "assembling",
				requestId: action.requestId,
				request: action.request,
				preview: action.preview ?? null,
				error: null,
			};
		case "preview-available":
			return ownsRequest(session, action.requestId) && session.phase === "assembling"
				? { ...session, phase: "ready", preview: action.preview, error: null }
				: session;
		case "preview-failed":
			return ownsRequest(session, action.requestId) && session.phase === "assembling"
				? { ...session, phase: "failed", error: action.error }
				: session;
		case "acceptance-started":
			return ownsRequest(session, action.requestId) &&
			(session.phase === "ready" || session.phase === "failed")
				? { ...session, phase: "accepting", error: null }
				: session;
		case "acceptance-succeeded":
			return ownsRequest(session, action.requestId) && session.phase === "accepting" ? null : session;
		case "acceptance-failed":
			return ownsRequest(session, action.requestId) && session.phase === "accepting"
				? { ...session, phase: "failed", error: action.error }
				: session;
		case "plan-edited":
			return ownsRequest(session, action.requestId) && session.preview !== null && session.phase !== "accepting"
				? {
						...session,
						preview: { ...session.preview, promptPlan: action.promptPlan },
						error: null,
					}
				: session;
		case "cancelled":
			return ownsRequest(session, action.requestId) ? null : session;
		case "conversation-switched":
			return null;
	}
}

export const isAssemblyPending = (session: AssemblySession | null): boolean =>
	session?.phase === "assembling" || session?.phase === "accepting";
