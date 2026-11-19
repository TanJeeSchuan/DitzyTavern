import type { Static, StaticDecode, TSchema } from "@sinclair/typebox";
import { responseErrorSchema, type ResponseErrorSchema, type ResponseMap } from "../../shared/contract/outcomes";
import { readRequestOutcome, type RequestOutcome, type TransportRequest, type WireOutcomeError } from "./request-outcome";
import { decodeWirePayload } from "./wire-decode";

type OutcomeResponseMap = ResponseMap & { 200: TSchema };
type RequestPayloads<Request extends TransportRequest> = [Extract<Awaited<Request>, { error: null }>["data"], WireOutcomeError<Request>];
type MapPayloads<Map extends OutcomeResponseMap> = [Static<Map[200]>, Static<ResponseErrorSchema<Map>>];
type SamePayloads<A, B> = [A, B] extends [B, A] ? unknown : never;

export function requestOutcome<Request extends TransportRequest, Map extends OutcomeResponseMap>(
	request: Request & SamePayloads<RequestPayloads<NoInfer<Request>>, MapPayloads<NoInfer<Map>>>,
	responses: Map,
): Promise<RequestOutcome<StaticDecode<Map[200]>, StaticDecode<ResponseErrorSchema<Map>>>> {
	const success: Map[200] = responses[200];
	return readRequestOutcome(request, success, (value) => decodeWirePayload(responseErrorSchema(responses), value));
}
