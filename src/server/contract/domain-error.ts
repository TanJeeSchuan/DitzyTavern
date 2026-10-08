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
type ErrorSchemas = Partial<Record<ErrorStatus, TSchema>>;
export type DomainErrorResponse<S extends ErrorSchemas> = {
	[C in keyof S]: C extends ErrorStatus
		? S[C] extends TSchema ? ElysiaCustomStatusResponse<C, Static<S[C]>> : never
		: never;
}[keyof S];

type DomainError = Error & {
	readonly outcome: keyof typeof outcomeStatus | keyof typeof recoveryField;
	readonly details?: object;
};
type Recovery = Record<string, (error: DomainError) => object | undefined>;
const recoveryField = {
	"stale-conversation": "currentConversation",
	"stale-memory-labels": "memories",
	"stale-lore-owner": "currentState",
} as const;

const isDomainError = (cause: unknown): cause is DomainError =>
	cause instanceof Error && "outcome" in cause && typeof cause.outcome === "string" &&
	(Object.hasOwn(outcomeStatus, cause.outcome) || Object.hasOwn(recoveryField, cause.outcome)) &&
	(!("details" in cause) || typeof cause.details === "object");

const errorMembers = (schema: TSchema): TSchema[] =>
	schema.anyOf === undefined ? [schema] : schema.anyOf.flatMap(errorMembers);

export function presentDomainError<S extends ErrorSchemas>(
	cause: unknown,
	schemas: S,
	recovery: Recovery = {},
	outcomes: Partial<Record<DomainError["outcome"], keyof typeof outcomeStatus>> = {},
): DomainErrorResponse<S> {
	if (!isDomainError(cause)) throw cause;
	const error = cause;
	const recovering = Object.hasOwn(recoveryField, error.outcome);
	// @approved
	// SAFETY: the domain guard proved the table membership; this read selects its recovery field.
	const field = recovering ? recoveryField[error.outcome as keyof typeof recoveryField] : undefined;
	const outcome = outcomes[error.outcome] ?? (recovering ? "conflict" : error.outcome);
	// @approved
	// SAFETY: recovery outcomes normalize to conflict; all others belong to the status table.
	let code = outcomeStatus[outcome as keyof typeof outcomeStatus];
	let schema = schemas[code];
	if (schema === undefined) throw error;
	const values = new Map(Object.entries(Object.assign({ ...error, outcome, reason: error.message }, error.details)));
	const candidates = errorMembers(schema);
	for (const candidate of candidates) {
		if (candidate.properties?.outcome?.const !== outcome) continue;
		// @approved
		// A recovery read belongs only to its own stale domain outcome.
		if (Object.keys(candidate.properties).some((key) => key in recovery &&
			field !== key)) continue;
		const body = Object.fromEntries(Object.keys(candidate.properties).map((key) => [
			key, key in recovery ? recovery[key](error) : values.get(key),
		]));
		if (field !== undefined && field in body && body[field] === undefined) {
			code = 404;
			schema = schemas[code];
			if (schema === undefined || !Value.Check(schema, { outcome: "not-found" })) throw error;
			// @approved
			// SAFETY: the route's declared 404 schema validated the recovery body.
			return status(code, { outcome: "not-found" }) as DomainErrorResponse<S>;
		}
		Value.Clean(candidate, body);
		if (!Value.Check(candidate, body)) continue;
		// @approved
		// SAFETY: the route's own schema validated this status and its exact body.
		return status(code, body) as DomainErrorResponse<S>;
	}
	throw error;
}
