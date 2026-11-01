import { decodeGenerationIntent } from "../../shared/contract/generation-intent";
import { InvalidConversationCommandError } from "./errors";

export function decodeStoredGenerationIntent(serialized: string) {
	try { return decodeGenerationIntent(serialized); }
	catch (error) { throw new InvalidConversationCommandError(error instanceof Error ? error.message : "Invalid Generation intent."); }
}

export const isProvisional = (variantId: number, active: readonly { variantId: number }[]): boolean =>
	active.some((row) => row.variantId === variantId);
