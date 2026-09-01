import { api } from "./lib/eden";
import { commandOutcome } from "./lib/command-outcome";
import type { PromptChannels } from "../shared/contract/prompt-schema";

// Typed client for the Character Library transport adapters. Outcomes mirror
// the server's typed results so the UI can recover from conflicts without
// losing local drafts.

export interface CharacterSummary {
	id: number;
	name: string;
	revision: number;
	pinned: boolean;
	preview: string;
	// Global provenance reference count (active or tombstoned Participants
	// forked from this Character), so pickers and lists present deletion
	// impact without one detail request per row.
	provenanceReferenceCount: number;
}

export type CharacterDeletionMode = "hard-delete" | "tombstone";

export interface CharacterDeletionImpact {
	provenanceReferenceCount: number;
	deletionMode: CharacterDeletionMode;
}

export interface CharacterSnapshot {
	id: number;
	name: string;
	revision: number;
	pinned: boolean;
	prompt: PromptChannels;
	openings: string[];
	// Derived deletion impact presented with every authoritative read so the
	// confirmation flow can show the exact consequence before any command.
	deletionImpact: CharacterDeletionImpact;
}

export type CharacterDeletionResult = {
	characterId: number;
	deletionMode: CharacterDeletionMode;
};

export type CharacterCommand =
	| {
			type: "create";
			definition: {
				name: string;
				prompt: PromptChannels;
				openings: string[];
			};
	  }
	| { type: "rename"; characterId: number; expectedRevision: number; name: string }
	| {
			type: "replace-prompt";
			characterId: number;
			expectedRevision: number;
			prompt: PromptChannels;
	  }
	| {
			type: "replace-openings";
			characterId: number;
			expectedRevision: number;
			openings: string[];
	  }
	| {
			type: "set-pinned";
			characterId: number;
			expectedRevision: number;
			pinned: boolean;
	  }
	// Confirmed deletion. The expected revision guards against deleting a
	// Character whose impact the caller has not seen; the outcome derives the
	// deletion mode from the current reference count.
	| {
			type: "delete";
			characterId: number;
			expectedRevision: number;
	  };

export type CommandOutcome =
	| { status: "applied"; character: CharacterSnapshot }
	// A confirmed deletion returns the derived mode instead of a snapshot:
	// neither a hard-deleted nor a tombstoned Character remains readable.
	| { status: "deleted"; result: CharacterDeletionResult }
	| { status: "conflict"; currentCharacter: CharacterSnapshot }
	| { status: "not-found" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export async function listCharacters(): Promise<CharacterSummary[]> {
	const { data, error } = await api.api.characters.get();
	if (error || !data) {
		throw new Error("Unable to list Characters");
	}
	return data.characters;
}

export async function getCharacter(
	characterId: number,
): Promise<CharacterSnapshot | null> {
	const { data, error } = await api.api.characters({ id: characterId }).get();
	if (error !== null && error !== undefined) {
		if (error.status === 404) {
			return null;
		}
		throw new Error(`Unable to load Character ${characterId}`);
	}
	return data ?? null;
}

export async function applyCommand(
	command: CharacterCommand,
): Promise<CommandOutcome> {
	const { data, error } = await api.api.characters.commands.post(command);
	if (error) {
		return commandOutcome(error.value, {
			conflict: (payload) => ({ status: "conflict", currentCharacter: payload.currentCharacter }),
			invalid: (payload) => ({ status: "invalid", reason: payload.reason }),
		});
	}
	// Deletion returns the typed result instead of a snapshot; every other
	// command returns the authoritative updated Character. The payload is a
	// union discriminated by the result-only `result` field.
	if ("result" in data) {
		return { status: "deleted", result: data.result };
	}
	return { status: "applied", character: data.character };
}
