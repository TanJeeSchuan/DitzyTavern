import { Type, type Static } from "@sinclair/typebox";
import { portrait } from "./image";
import { promptChannels } from "./prompt-schema";
import { numericWire } from "./wire";

// Typed transport schemas mirror the Character Library seam's public types.
// Routes stay thin adapters: persistence and validation rules live behind
// the deep module, never here.

export const characterLibrarySummary = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	revision: Type.Integer(),
	pinned: Type.Boolean(),
	preview: Type.String(),
	portrait: Type.Optional(portrait),
	// ==[HUMAN APPROVED]== Global provenance reference count (active or tombstoned
	// Participants forked from this Character), so pickers and lists present
	// deletion impact without one detail request per row.
	provenanceReferenceCount: Type.Integer(),
});

export const characterDeletionMode = Type.Union([
	Type.Literal("hard-delete"),
	Type.Literal("tombstone"),
]);

// ==[HUMAN APPROVED]== Derived deletion impact presented with every authoritative read so the
// confirmation flow can show the exact consequence before any command.
export const characterDeletionImpact = Type.Object({
	provenanceReferenceCount: Type.Integer(),
	deletionMode: characterDeletionMode,
});

// A complete reusable identity. Openings are ordered, exact, nonblank
// text entries; an empty list is valid.
export const characterSnapshot = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	revision: Type.Integer(),
	pinned: Type.Boolean(),
	prompt: promptChannels,
	openings: Type.Array(Type.String()),
	portrait: Type.Optional(portrait),
	deletionImpact: characterDeletionImpact,
});

// Outcome of a confirmed deletion: the mode is derived from the reference
// count at command time, never guessed by the client.
export const characterDeletionResult = Type.Object({
	characterId: Type.Integer(),
	deletionMode: characterDeletionMode,
});

const createCommand = Type.Object({
	type: Type.Literal("create"),
	definition: Type.Object({
		name: Type.String(),
		prompt: promptChannels,
		openings: Type.Array(Type.String()),
		portrait: Type.Optional(portrait),
	}),
});

const renameCommand = Type.Object({
	type: Type.Literal("rename"),
	characterId: Type.Integer(),
	expectedRevision: Type.Integer(),
	name: Type.String(),
});

const updateDefinitionCommand = Type.Object({
	type: Type.Literal("update-definition"),
	characterId: Type.Integer(),
	expectedRevision: Type.Integer(),
	definition: createCommand.properties.definition,
});

const replacePromptCommand = Type.Object({
	type: Type.Literal("replace-prompt"),
	characterId: Type.Integer(),
	expectedRevision: Type.Integer(),
	prompt: promptChannels,
});

const replaceOpeningsCommand = Type.Object({
	type: Type.Literal("replace-openings"),
	characterId: Type.Integer(),
	expectedRevision: Type.Integer(),
	openings: Type.Array(Type.String()),
});

const setPinnedCommand = Type.Object({
	type: Type.Literal("set-pinned"),
	characterId: Type.Integer(),
	expectedRevision: Type.Integer(),
	pinned: Type.Boolean(),
});

// Confirmed deletion. The expected revision guards against deleting a
// Character whose impact the caller has not seen; the outcome derives the
// deletion mode from the current reference count.
const deleteCommand = Type.Object({
	type: Type.Literal("delete"),
	characterId: Type.Integer(),
	expectedRevision: Type.Integer(),
});

export const commandBodySchema = Type.Union([
	createCommand,
	updateDefinitionCommand,
	renameCommand,
	replacePromptCommand,
	replaceOpeningsCommand,
	setPinnedCommand,
	deleteCommand,
]);

// Route boundary schemas referenced by the Character Library adapter.
// Canonical transport types. The server domain seam and the client both
// import these Static types instead of restating the shapes, so the three
// layers can never drift apart. The reusable Definition is the create
// command's payload: creation is the only path that introduces one.
export type CharacterLibrarySummary = Static<typeof characterLibrarySummary>;
export type CharacterDeletionMode = Static<typeof characterDeletionMode>;
export type CharacterDeletionImpact = Static<typeof characterDeletionImpact>;
export type CharacterDefinition = Static<typeof createCommand>["definition"];
export type CharacterSnapshot = Static<typeof characterSnapshot>;
export type CharacterDeletionResult = Static<typeof characterDeletionResult>;
export type CharacterCommand = Static<typeof commandBodySchema>;

export const characterIdParams = Type.Object({ id: numericWire });

export const characterListResponse = Type.Object({
	characters: Type.Array(characterLibrarySummary),
});

// A confirmed deletion returns the typed result rather than a snapshot and
// neither stays readable; every other command returns the authoritative
// updated Character. DeletionMode is exclusive to the result, so the
// discriminant keeps the two applied payloads distinct.
export const characterCommandApplied = Type.Union([
	Type.Object({
		outcome: Type.Literal("applied"),
		character: characterSnapshot,
	}),
	Type.Object({
		outcome: Type.Literal("applied"),
		result: characterDeletionResult,
	}),
]);

// Stale-revision conflict carrying the authoritative current Character so
// the caller can recover without a follow-up read.
export const characterConflict = Type.Object({
	outcome: Type.Literal("conflict"),
	expectedRevision: Type.Integer(),
	actualRevision: Type.Integer(),
	currentCharacter: characterSnapshot,
});
