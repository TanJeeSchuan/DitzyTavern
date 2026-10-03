import { Value } from "@sinclair/typebox/value";
import { api } from "./lib/eden";
import { decodeWirePayload } from "./lib/wire-decode";
import {
	lorebook,
	lorebookCommandApplied,
	lorebookDeleted,
	lorebookImportApplied,
	lorebookListResponse,
	loreMatchTestResponse,
	loreAttachmentState,
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

export type LoreAttachmentCommandOutcome =
	| { status: "applied" }
	| { status: "conflict"; expectedRevision: number; actualRevision: number; currentState: LoreAttachmentState | LorebookOwnerAttachmentState }
	| { status: "invalid"; reason: string }
	| { status: "not-found" }
	| { status: "network" };

export async function applyLorebookAttachmentCommand(command: LoreAttachmentCommand): Promise<LoreAttachmentCommandOutcome> {
	try {
		const { error } = await api.api.lorebooks.attachments.commands.post(command);
		if (error) {
			// ==[HUMAN APPROVED]== SAFETY: Eden exposes the typed public error union; this assertion names only its shared outcome fields.
			const value = error.value as { outcome?: string; reason?: string; expectedRevision?: number; actualRevision?: number; currentState?: LoreAttachmentState | LorebookOwnerAttachmentState } | null;
			if (value?.outcome === "conflict" && value.currentState !== undefined) {
				return {
					status: "conflict",
					expectedRevision: value.expectedRevision ?? command.expectedRevision,
					actualRevision: value.actualRevision ?? value.currentState.revision,
					currentState: value.currentState,
				};
			}
			if (value?.outcome === "invalid") return { status: "invalid", reason: value.reason ?? "Invalid Lorebook attachment command." };
			if (error.status === 404) return { status: "not-found" };
			return { status: "network" };
		}
		return { status: "applied" };
	} catch {
		return { status: "network" };
	}
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

export type LorebookCommandOutcome =
	| { status: "applied"; book: LorebookValue }
	| { status: "deleted"; bookId: number }
	| { status: "conflict"; expectedRevision: number; actualRevision: number; currentBook: LorebookValue }
	| { status: "invalid"; reason: string }
	| { status: "not-found" }
	| { status: "network" };

export async function applyLorebookCommand(command: LorebookCommand): Promise<LorebookCommandOutcome> {
	try {
		const { data, error } = await api.api.lorebooks.commands.post(command);
		if (error) {
			// ==[HUMAN APPROVED]== SAFETY: Eden's typed error union is narrowed by the outcome tag before values are read.
			const value = error.value as { outcome?: string; reason?: string; expectedRevision?: number; actualRevision?: number; currentBook?: LorebookValue } | null;
			if (value?.outcome === "conflict" && value.currentBook !== undefined) {
				const expectedRevision = "expectedRevision" in command ? command.expectedRevision : 0;
				return { status: "conflict", expectedRevision: value.expectedRevision ?? expectedRevision, actualRevision: value.actualRevision ?? value.currentBook.revision, currentBook: value.currentBook };
			}
			if (value?.outcome === "invalid") return { status: "invalid", reason: value.reason ?? "Invalid Lorebook command." };
			if (error.status === 404) return { status: "not-found" };
			return { status: "network" };
		}
		const deleted = decodeWirePayload(lorebookDeleted, data);
		if (deleted !== null) return { status: "deleted", bookId: deleted.bookId };
		const applied = decodeWirePayload(lorebookCommandApplied, data);
		return applied === null ? { status: "network" } : { status: "applied", book: applied.book };
	} catch {
		return { status: "network" };
	}
}

export function parseNativeLorebook(text: string): NativeLorebook | null {
	try {
		return Value.Parse(nativeLorebook, JSON.parse(text));
	} catch {
		return null;
	}
}

export async function importNativeLorebook(native: NativeLorebook): Promise<{ status: "applied"; book: LorebookValue; warnings: string[] } | { status: "invalid"; reason: string } | { status: "network" }> {
	try {
		const { data, error } = await api.api.lorebooks.import.post(native);
		if (error) {
			// ==[HUMAN APPROVED]== SAFETY: invalid transport errors carry only the public reason string.
			const value = error.value as { reason?: string } | null;
			return error.status === 422 ? { status: "invalid", reason: value?.reason ?? "Invalid Lorebook JSON." } : { status: "network" };
		}
		const applied = decodeWirePayload(lorebookImportApplied, data);
		return applied === null ? { status: "network" } : { status: "applied", book: applied.book, warnings: applied.warnings };
	} catch {
		return { status: "network" };
	}
}

export async function importSillyTavernLorebook(source: SillyTavernJsonValue): Promise<{ status: "applied"; book: LorebookValue; warnings: string[] } | { status: "invalid"; reason: string } | { status: "network" }> {
	try {
		const { data, error } = await api.api.lorebooks.import.sillytavern.post({ source });
		if (error) {
			// ==[HUMAN APPROVED]== SAFETY: invalid transport errors carry only the public reason string.
			const value = error.value as { reason?: string } | null;
			return error.status === 422 ? { status: "invalid", reason: value?.reason ?? "Invalid Lorebook JSON." } : { status: "network" };
		}
		const applied = decodeWirePayload(lorebookImportApplied, data);
		return applied === null ? { status: "network" } : { status: "applied", book: applied.book, warnings: applied.warnings };
	} catch {
		return { status: "network" };
	}
}

export async function exportNativeLorebook(bookId: number): Promise<NativeLorebook> {
	const { data, error } = await api.api.lorebooks({ bookId }).export.get();
	if (error || !data) throw new Error("Unable to export Lorebook");
	const exported = decodeWirePayload(nativeLorebook, data);
	if (exported === null) throw new Error("Unable to export Lorebook");
	return exported;
}
