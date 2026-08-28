import { treaty } from "@elysiajs/eden";
import type { Contract } from "../../shared/contract";

// Contracts expose timestamps as wire strings. Keep Eden from eagerly
// converting ISO-looking JSON strings to Date instances so the client sees
// the same transport shape as fetch and the shared Static types describe.
export const api = treaty<Contract>(window.location.origin, { parseDate: false });
