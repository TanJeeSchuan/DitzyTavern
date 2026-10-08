import { StaleConversationRevisionError } from "../conversation";
import { StaleMemoryLabelsError } from "../memory/labels";
import { StaleLoreAttachmentOwnerRevisionError } from "../lorebook/errors";
import type { RecoverDomainError } from "./domain-error";

export const recoverConversationConflict = (read: () => object | undefined): RecoverDomainError => (error) => {
	if (!(error instanceof StaleConversationRevisionError)) return error;
	const currentConversation = read();
	return currentConversation === undefined ? { outcome: "not-found" } : {
		outcome: "conflict",
		details: { expectedRevision: error.expectedRevision, actualRevision: error.actualRevision, currentConversation },
	};
};

export const recoverMemoryLabelsConflict = (read: () => object): RecoverDomainError => (error) =>
	error instanceof StaleMemoryLabelsError ? { outcome: "conflict", details: { memories: read() } } : error;

export const recoverLoreOwnerConflict = (read: (characterId: number) => object | undefined): RecoverDomainError => (error) => {
	if (!(error instanceof StaleLoreAttachmentOwnerRevisionError)) return error;
	const currentState = read(error.characterId);
	return currentState === undefined ? { outcome: "not-found" } : {
		outcome: "conflict", details: { ...error.details, currentState },
	};
};
