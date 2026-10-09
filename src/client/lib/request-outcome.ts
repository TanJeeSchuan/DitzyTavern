import type { Static, StaticDecode, TSchema } from "@sinclair/typebox";
import { decodeWirePayload } from "./wire-decode";
import type { WirePayload } from "./wire-decode";

// @approved
//  The one client transport outcome: the decoded 200 payload rides under
// the wire word `outcome` as `available`, the route's modeled wire error
// union passes through verbatim, a request the transport never completed is
// network, and a response the client could not read is unusable with the
// seam's own reason. Transport failure, unusable response, and a route's
// modeled error envelopes stay distinguishable, so recovery loops that back
// off on NetworkError never retry a server that answered and a genuine 422
// `invalid` envelope — which several routes model — never reads as a seam
// failure. Every member is outcome-tagged: the helper's error-schema
// constraint keeps the modeled error union to the route's envelopes.
export type RequestOutcome<Value, Error> =
	| { outcome: "available"; value: Value }
	| Error
	| { outcome: "network" }
	| { outcome: "unusable"; reason: string };

// @approved
//  Elysia's default request-validation body: the one error shape a route
// never declares but Treaty still unions into `error.value`. It has no wire
// outcome tag, so the modeled error union is derived without it.
type ValidationFailure = {
	type: "validation";
	on: string;
	summary?: string | undefined;
	message?: string | undefined;
	property?: string | undefined;
	expected?: string | undefined;
};

// @approved
//  The route's modeled wire error union, read straight off the Treaty request
// and stripped of the undeclared validation envelope.
type TransportErrorValue<Request> = Awaited<Request> extends { error: infer Error }
	? Exclude<Error, null> extends { value: infer Value } ? Value : never
	: never;

type WireOutcomeError<Request> = Exclude<TransportErrorValue<Request>, ValidationFailure>;

type TransportRequest = Promise<{
	data: WirePayload;
	error: { status: number; value: WirePayload | ValidationFailure } | null;
	// @approved
	//  Eden resolves a fetch rejection as a 503 error result with no
	// Response. That missing Response is the one transport-failure signal
	// available after Eden swallows the rejection; a hand-written request
	// type that never models it can only fail as a response failure.
	response?: Response | undefined;
}>;

// @approved
//  The one client transport seam: every command and read adapter hands its
// Treaty request, the 200 contract schema, and the route family's modeled
// error-union schema here. The error body is decoded against the error
// schema exactly as the 200 body is decoded against the success schema —
// an unmodeled tag, a missing field, or a validation envelope is the shared
// unusable fallback, while only a result with no Response is network. The
// error-schema constraint pins its Static to the route's own derived error
// union in both directions, so an under-declared or wrong-family schema is a
// type error at the call site.
export const requestOutcome = async <
	Request extends TransportRequest,
	Schema extends TSchema,
	Errors extends TSchema
		& { static: WireOutcomeError<Request> }
		& ([WireOutcomeError<Request>] extends [Static<Errors>] ? unknown : never),
>(
	request: Request,
	schema: Schema,
	errors: Errors,
): Promise<RequestOutcome<StaticDecode<Schema>, StaticDecode<Errors>>> => {
	let result: Awaited<Request>;
	try {
		result = await request;
	} catch {
		// @approved
		//  Eden rejects while reading a response body it already received; the
		// transport never completed only when the result carries no Response.
		return unusableResponse;
	}
	const { data, error } = result;
	if (error) {
		return result.response === undefined
			? { outcome: "network" }
			: decodeWirePayload(errors, error.value) ?? unusableResponse;
	}
	const decoded = decodeWirePayload(schema, data);
	return decoded === null ? unusableResponse : { outcome: "available", value: decoded };
};

export class NetworkError extends Error {}

// @approved
//  The one copy a request the transport never completed throws: read
// adapters that branch on an outcome throw NetworkError with this notice,
// so recovery loops retry by catching exactly this failure and surfacing
// never drifts between modules.
export const SERVER_UNREACHABLE_NOTICE = "The server could not be reached.";

// @approved
//  The one copy a response the client could not read throws or folds to: it
// is true of an error status and of a body that fails its contract, so
// requestData throws a plain Error with it and requestOutcome folds the same
// reason into the shared unusable fallback.
export const SERVER_UNUSABLE_RESPONSE_NOTICE = "The server returned an unusable response.";

// @approved
//  The one unusable-response outcome: the seam's own reason under its own
// tag, distinct from network so a reached server's unusable answer never
// enters a transport back-off loop, and distinct from the routes that model
// a genuine 422 `invalid` envelope so that envelope reads as itself.
const unusableResponse = { outcome: "unusable", reason: SERVER_UNUSABLE_RESPONSE_NOTICE } as const;

// @approved
//  The one "throw on anything but 200" read dialect: every read adapter
// without a modeled error envelope hands its Treaty request and 200 contract
// schema here. The decoded 200 payload is returned verbatim; a rejected
// request is the retryable NetworkError, while an error status or a body
// that fails its contract is a plain Error with the shared unusable-response
// notice that no NetworkError back-off loop retries.
export const requestData = async <Request extends TransportRequest, Schema extends TSchema>(
	request: Request,
	schema: Schema,
): Promise<StaticDecode<Schema>> => {
	let result: Awaited<Request>;
	try {
		result = await request;
	} catch {
		throw new Error(SERVER_UNUSABLE_RESPONSE_NOTICE);
	}
	if (result.error !== null) {
		if (result.response === undefined) throw new NetworkError(SERVER_UNREACHABLE_NOTICE);
		throw new Error(SERVER_UNUSABLE_RESPONSE_NOTICE);
	}
	const decoded = decodeWirePayload(schema, result.data);
	if (decoded !== null) return decoded;
	throw new Error(SERVER_UNUSABLE_RESPONSE_NOTICE);
};
