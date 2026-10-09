import type { GenerationPreview } from "../shared/contract/conversation-schema";

export type AssemblySessionPhase = "assembling" | "ready" | "accepting" | "failed";

/** @approved
 * The Prompt Plan preview as the panel renders it: the phase and error derive
 * from the preview query and the acceptance mutation, so no request identity
 * is carried here.
 */
export type AssemblySession = {
	phase: AssemblySessionPhase;
	preview: GenerationPreview | null;
	error: string | null;
};

export const isAssemblyPending = (session: AssemblySession | null): boolean =>
	session?.phase === "assembling" || session?.phase === "accepting";
