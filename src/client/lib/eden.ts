import { treaty } from "@elysiajs/eden";
import type { Contract } from "../../shared/contract";

export const api = treaty<Contract>(window.location.origin);
