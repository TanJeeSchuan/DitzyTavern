import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { status, type ElysiaCustomStatusResponse } from "elysia";

const outcomeStatus = {
	"not-found": 404,
	conflict: 409,
	"not-playable": 409,
	"not-removable": 409,
	expired: 410,
	unavailable: 410,
	invalid: 422,
} as const;

type ErrorStatus = (typeof outcomeStatus)[keyof typeof outcomeStatus];
export type ResponseSchemas = Partial<Record<number, TSchema>>;
export type DomainErrorResponse<S extends ResponseSchemas> = {
	[C in keyof S]: C extends ErrorStatus
		? S[C] extends TSchema ? ElysiaCustomStatusResponse<C, Static<S[C]>> : never
		: never;
}[keyof S];

type DomainFailure = {
	readonly outcome: keyof typeof outcomeStatus;
	readonly details?: object;
};
type DomainError = Error & DomainFailure;
export type RecoverDomainError = (error: DomainError) => DomainFailure;

const isDomainError = (cause: unknown): cause is DomainError =>
	cause instanceof Error && "outcome" in cause && typeof cause.outcome === "string" &&
	Object.hasOwn(outcomeStatus, cause.outcome) &&
	(!("details" in cause) || (cause.details !== null && typeof cause.details === "object"));

export function presentDomainError<S extends ResponseSchemas>(
	cause: unknown,
	responses: S,
	recover?: RecoverDomainError,
): DomainErrorResponse<S> {
	if (!isDomainError(cause)) throw cause;
	const error = recover === undefined ? cause : recover(cause);
	const code = outcomeStatus[error.outcome];
	const schema = responses[code];
	const body = { outcome: error.outcome, ...error.details };
	if (schema === undefined || !Value.Check(schema, body)) throw cause;
	// @approved
	// SAFETY: the route's declared schema validated this status and its payload.
	return status(code, body) as DomainErrorResponse<S>;
}
