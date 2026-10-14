import { treaty } from "@elysiajs/eden";
import type { AnyElysia } from "elysia";
import type { Contract } from "../../server/contract";
import type { BoxId } from "../../shared/contract/box";

// @approved
//  Contracts expose timestamps as wire strings. Keep Eden from eagerly
// converting ISO-looking JSON strings to Date instances so the client sees
// the same transport shape as fetch and the shared Static types describe.
export const api = treaty<Contract>(window.location.origin, { parseDate: false });
/** @approved A Box's own `routes`, which the host serves under `/api/boxes/<id>`. */
export const boxApi = <Routes extends AnyElysia>(id: BoxId) => treaty<Routes>(`${window.location.origin}/api/boxes/${id}`, { parseDate: false });

// @approved
//  Eden's Treaty response is a discriminated success/error union. Keep that
// union shape at client transport helpers instead of forcing each caller to
// repeat a broad type assertion around `data` and `error`.
export type EdenResponse<Data, Error> = Promise<
	| { data: Data; error: null }
	| { data: null; error: Error }
>;
