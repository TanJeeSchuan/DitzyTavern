import type { Static, StaticDecode, TSchema } from "@sinclair/typebox";
import { decodeWirePayload } from "./wire-decode";
import type { WirePayload } from "./wire-decode";

// ==[HUMAN APPROVED]== The one client transport outcome: the decoded 200 payload rides under
// the wire word `outcome` as `available`, the route's modeled wire error
// union passes through verbatim, and anything the request or response seam
// could not classify — a failed fetch, a body that fails either contract —
// is network. Every member is outcome-tagged: the helper's error-schema
// constraint keeps the error union to the route's modeled envelopes.
export type RequestOutcome<Value, Error> =
	| { outcome: "available"; value: Value }
	| Error
	| { outcome: "network" };

// ==[HUMAN APPROVED]== Elysia's default request-validation body: the one error shape a route
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

// ==[HUMAN APPROVED]== The route's modeled wire error union, read straight off the Treaty request
// and stripped of the undeclared validation envelope.
type TransportErrorValue<Request> = Awaited<Request> extends { error: infer Error }
	? Exclude<Error, null> extends { value: infer Value } ? Value : never
	: never;

type WireOutcomeError<Request> = Exclude<TransportErrorValue<Request>, ValidationFailure>;

type TransportRequest = Promise<{
	data: WirePayload;
	error: { status: number; value: WirePayload | ValidationFailure } | null;
}>;

// ==[HUMAN APPROVED]== The one client transport seam: every command and read adapter hands its
// Treaty request, the 200 contract schema, and the route family's modeled
// error-union schema here. The error body is decoded against the error
// schema exactly as the 200 body is decoded against the success schema —
// an unmodeled tag, a missing field, or a validation envelope is network.
// The error-schema constraint pins its Static to the route's own derived
// error union in both directions, so an under-declared or wrong-family
// schema is a type error at the call site.
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
	try {
		const { data, error } = await request;
		if (error) {
			const modeled = decodeWirePayload(errors, error.value);
			return modeled ?? { outcome: "network" };
		}
		const decoded = decodeWirePayload(schema, data);
		return decoded === null
			? { outcome: "network" }
			: { outcome: "available", value: decoded };
	} catch {
		return { outcome: "network" };
	}
};
