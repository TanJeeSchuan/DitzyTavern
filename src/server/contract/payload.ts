import { status } from "elysia";
import { StaleCharacterRevisionError } from "../character-library";
import { toCharacterPayload, toConversationSummary } from "./projections";

// Keep this adapter export stable for the conversation routes while the
// implementation lives below the route-adapter layer.
export { toConversationSummary };

// Builds the typed 409 conflict payload for a stale Character revision so
// every adapter that forks or edits Characters presents the same recovery
// shape: the authoritative current Character rides inside the conflict.
export const staleCharacterConflict = (error: StaleCharacterRevisionError) => ({
	outcome: "conflict" as const,
	expectedRevision: error.expectedRevision,
	actualRevision: error.actualRevision,
	currentCharacter: toCharacterPayload(error.currentCharacter),
});

// Shared response builders for adapter catch sites. Each calls the elysia
// global `status` directly so route handlers can return the precise typed
// response without re-declaring per-status overloads for every route context.
export const notFoundResponse = () => status(404, { outcome: "not-found" as const });

export const invalidResponse = (reason: string) =>
	status(422, { outcome: "invalid" as const, reason });

export const staleCharacterConflictResponse = (error: StaleCharacterRevisionError) =>
	status(409, staleCharacterConflict(error));
