import { status } from "elysia";

// @approved
//  Shared response builders for adapter catch sites. Each calls the elysia
// global `status` directly so route handlers can return the precise typed
// response without re-declaring per-status overloads for every route context.
export const notFoundResponse = () => status(404, { outcome: "not-found" as const });

export const invalidResponse = (reason: string) =>
	status(422, { outcome: "invalid" as const, reason });
