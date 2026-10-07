import type { StaticDecode, TSchema } from "@sinclair/typebox";
import { decodeWirePayload, type WirePayload } from "./wire-decode";

// ==[HUMAN APPROVED]== The one client transport outcome: the decoded 200 payload rides under
// the wire word `outcome` as `available`, the route's modeled wire error
// union passes through verbatim, and anything the request or response seam
// could not classify — a failed fetch, a body that fails the contract, an
// error body without the wire outcome tag — is network.
export type RequestOutcome<Value, Error extends WireError> =
	| { outcome: "available"; value: Value }
	| Error
	| { outcome: "network" };

// ==[HUMAN APPROVED]== Every modeled wire error carries the shared `outcome` tag.
export type WireError = { outcome: string };

// ==[HUMAN APPROVED]== Elysia's default request-validation body: the one error shape a route
// never declares but Treaty still unions into `error.value`. It has no wire
// outcome tag, so the classification below never mistakes it for a modeled
// outcome.
type ValidationFailure = {
	type: "validation";
	on: string;
	summary?: string | undefined;
	message?: string | undefined;
	found?: unknown;
	property?: string | undefined;
	expected?: string | undefined;
};

// ==[HUMAN APPROVED]== The route's modeled wire error union, read straight off the Treaty request
// and stripped of the undeclared validation envelope.
type TransportErrorValue<Request> = Awaited<Request> extends { error: infer Error }
	? Exclude<Error, null> extends { value: infer Value } ? Value : never
	: never;

export type WireOutcomeError<Request> = Exclude<TransportErrorValue<Request>, ValidationFailure>;

type TransportRequest = Promise<{
	data: WirePayload;
	error: { status: number; value: WirePayload | ValidationFailure } | null;
}>;

// ==[HUMAN APPROVED]== An error body is a wire outcome only when it carries the wire outcome
// tag; every other body (Elysia's validation envelope, a server 500, a
// proxy page) is network-class, so unmodeled payloads never leak into the
// typed outcome union.
const isWireError = <Error extends WireError>(value: unknown): value is Error =>
	typeof value === "object" && value !== null && "outcome" in value;

// ==[HUMAN APPROVED]== The one client transport seam: every command and read adapter hands its
// Treaty request and the 200 contract schema here. The route's modeled error
// union is read off the request type itself, so no per-function outcome
// vocabulary exists anywhere else.
export const requestOutcome = async <
	Request extends TransportRequest,
	Schema extends TSchema,
>(
	request: Request,
	schema: Schema,
): Promise<RequestOutcome<StaticDecode<Schema>, WireOutcomeError<Request>>> => {
	try {
		const { data, error } = await request;
		if (error) {
			return isWireError<WireOutcomeError<Request>>(error.value)
				? error.value
				: { outcome: "network" };
		}
		const decoded = decodeWirePayload(schema, data);
		return decoded === null
			? { outcome: "network" }
			: { outcome: "available", value: decoded };
	} catch {
		return { outcome: "network" };
	}
};
