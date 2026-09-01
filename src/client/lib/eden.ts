import { treaty } from "@elysiajs/eden";
import type { Contract } from "../../server/contract";

// ==[HUMAN APPROVED]== Contracts expose timestamps as wire strings. Keep Eden from eagerly
// converting ISO-looking JSON strings to Date instances so the client sees
// the same transport shape as fetch and the shared Static types describe.
export const api = treaty<Contract>(window.location.origin, { parseDate: false });

// ==[HUMAN APPROVED]== Eden's Treaty response is a discriminated success/error union. Keep that
// union shape at client transport helpers instead of forcing each caller to
// repeat a broad type assertion around `data` and `error`.
export type EdenResponse<Data, Error> = Promise<
	| { data: Data; error: null }
	| { data: null; error: Error }
>;
