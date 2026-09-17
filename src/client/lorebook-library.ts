import { Value } from "@sinclair/typebox/value";
import { api } from "./lib/eden";
import { decodeWirePayload } from "./lib/wire-decode";
import {
	lorebook,
	lorebookCommandApplied,
	lorebookDeleted,
	lorebookImportApplied,
	lorebookListResponse,
	nativeLorebook,
	type LorebookCommand,
	type NativeLorebook,
	type Lorebook as LorebookValue,
	type LorebookListResponse,
} from "../shared/contract/lorebook";
import type { SillyTavernJsonValue } from "../shared/contract/prompt-preset";

export type { LorebookCommand, NativeLorebook, LorebookValue as Lorebook, LorebookListResponse };

export async function listLorebooks(): Promise<LorebookListResponse["books"]> {
	const { data, error } = await api.api.lorebooks.get();
	if (error || !data) throw new Error("Unable to list Lorebooks");
	const decoded = decodeWirePayload(lorebookListResponse, data);
	if (decoded === null) throw new Error("Unable to list Lorebooks");
	return decoded.books;
}

export async function getLorebook(bookId: number): Promise<LorebookValue | null> {
	const { data, error } = await api.api.lorebooks({ bookId }).get();
	if (error) {
		if (error.status === 404) return null;
		throw new Error("Unable to load Lorebook");
	}
	return data === null ? null : decodeWirePayload(lorebook, data);
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
