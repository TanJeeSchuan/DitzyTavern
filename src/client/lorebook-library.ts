import { Value } from "@sinclair/typebox/value";
import { api } from "./lib/eden";
import { requestOutcome } from "./lib/request-outcome";
import { decodeWirePayload } from "./lib/wire-decode";
import {
	lorebook,
	lorebookCommandErrors,
	lorebookCommandResponse,
	lorebookImportApplied,
	lorebookListResponse,
	loreMatchTestResponse,
	loreAttachmentState,
	loreAttachmentCommandErrors,
	loreAttachmentCommandResponse,
	lorebookAttachmentImpact,
	lorebookOwnerAttachmentState,
	type LoreAttachmentState,
	type LoreAttachmentCommand,
	type LorebookAttachmentImpact,
	type LorebookOwnerAttachmentState,
	nativeLorebook,
	type LoreMatchTestResponse,
	type LorebookCommand,
	type NativeLorebook,
	type Lorebook as LorebookValue,
	type LorebookListResponse,
} from "../shared/contract/lorebook";
import { readOutcomeErrors } from "../shared/contract/outcomes";
import type { SillyTavernJsonValue } from "../shared/contract/prompt-preset";

export type { LorebookCommand, NativeLorebook, LorebookValue as Lorebook, LorebookListResponse, LoreAttachmentState, LoreAttachmentCommand };
export type { LorebookAttachmentImpact };
export type { LorebookOwnerAttachmentState };
export type LoreMatchTest = LoreMatchTestResponse;

export async function getLorebookAttachmentState(conversationId: number, signal?: AbortSignal): Promise<LoreAttachmentState | null> {
	const { data, error } = await api.api.lorebooks.attachments.get({ query: { conversationId }, fetch: { signal } });
	if (error) {
		if (error.status === 404) return null;
		throw new Error("Unable to load Lorebook attachments");
	}
	return decodeWirePayload(loreAttachmentState, data);
}

export async function applyLorebookAttachmentCommand(command: LoreAttachmentCommand) {
	return requestOutcome(
		api.api.lorebooks.attachments.commands.post(command),
		loreAttachmentCommandResponse,
		loreAttachmentCommandErrors,
	);
}

export async function getLorebookAttachmentImpact(bookId: number): Promise<LorebookAttachmentImpact | null> {
	const { data, error } = await api.api.lorebooks({ bookId }).attachments.get();
	if (error) {
		if (error.status === 404) return null;
		throw new Error("Unable to load Lorebook deletion impact");
	}
	return decodeWirePayload(lorebookAttachmentImpact, data);
}

export async function getCharacterLorebookAttachments(characterId: number): Promise<LorebookOwnerAttachmentState | null> {
	const { data, error } = await api.api.lorebooks.attachments.character.get({ query: { ownerId: characterId } });
	if (error) {
		if (error.status === 404) return null;
		throw new Error("Unable to load Character Lorebooks");
	}
	return decodeWirePayload(lorebookOwnerAttachmentState, data);
}

export async function getParticipantLorebookAttachments(participantId: number): Promise<LorebookOwnerAttachmentState | null> {
	const { data, error } = await api.api.lorebooks.attachments.participant.get({ query: { ownerId: participantId } });
	if (error) {
		if (error.status === 404) return null;
		throw new Error("Unable to load Participant Lorebooks");
	}
	return decodeWirePayload(lorebookOwnerAttachmentState, data);
}

export async function listLorebooks(signal?: AbortSignal): Promise<LorebookListResponse["books"]> {
	const { data, error } = await api.api.lorebooks.get({ fetch: { signal } });
	if (error || !data) throw new Error("Unable to list Lorebooks");
	const decoded = decodeWirePayload(lorebookListResponse, data);
	if (decoded === null) throw new Error("Unable to list Lorebooks");
	return decoded.books;
}

export async function getLorebook(bookId: number, signal?: AbortSignal): Promise<LorebookValue | null> {
	const { data, error } = await api.api.lorebooks({ bookId }).get({ fetch: { signal } });
	if (error) {
		if (error.status === 404) return null;
		throw new Error("Unable to load Lorebook");
	}
	return data === null ? null : decodeWirePayload(lorebook, data);
}

export async function testLorebookMatch(bookId: number, writing: string): Promise<LoreMatchTest> {
	const { data, error } = await api.api.lorebooks["match-test"].post({ bookId, writing });
	if (error || data === undefined || data === null) {
		if (error?.status === 404) throw new Error("That Lorebook no longer exists.");
		throw new Error("Lorebook matching could not be tested.");
	}
	const decoded = decodeWirePayload(loreMatchTestResponse, data);
	if (decoded === null) throw new Error("Lorebook matching returned an invalid result.");
	return decoded;
}

export async function applyLorebookCommand(command: LorebookCommand) {
	return requestOutcome(
		api.api.lorebooks.commands.post(command),
		lorebookCommandResponse,
		lorebookCommandErrors,
	);
}

export function parseNativeLorebook(text: string): NativeLorebook | null {
	try {
		return Value.Parse(nativeLorebook, JSON.parse(text));
	} catch {
		return null;
	}
}

export async function importNativeLorebook(native: NativeLorebook) {
	return requestOutcome(
		api.api.lorebooks.import.post(native),
		lorebookImportApplied,
		readOutcomeErrors,
	);
}

export async function importSillyTavernLorebook(source: SillyTavernJsonValue) {
	return requestOutcome(
		api.api.lorebooks.import.sillytavern.post({ source }),
		lorebookImportApplied,
		readOutcomeErrors,
	);
}

export async function exportNativeLorebook(bookId: number): Promise<NativeLorebook> {
	const { data, error } = await api.api.lorebooks({ bookId }).export.get();
	if (error || !data) throw new Error("Unable to export Lorebook");
	const exported = decodeWirePayload(nativeLorebook, data);
	if (exported === null) throw new Error("Unable to export Lorebook");
	return exported;
}
