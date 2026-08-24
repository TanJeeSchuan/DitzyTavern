import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import {
	CharacterNotFoundError,
	InvalidCharacterCommandError,
	InvalidCharacterDefinitionError,
	type CharacterSnapshot,
	StaleCharacterRevisionError,
	withCharacterLibrary,
} from "../../server/character-library";

// Typed transport schemas mirror the Character Library seam's public types.
// Routes stay thin adapters: persistence and validation rules live behind
// the deep module, never here.

// Adapts the seam's immutable snapshot into the transport shape.
export const toCharacterPayload = (character: CharacterSnapshot) => ({
	...character,
	openings: [...character.openings],
});


const characterLibrarySummary = t.Object({
	id: t.Integer(),
	name: t.String(),
	revision: t.Integer(),
	pinned: t.Boolean(),
	preview: t.String(),
	// Global provenance reference count so pickers and lists present
	// deletion impact without one detail request per row.
	provenanceReferenceCount: t.Integer(),
});

const characterPrompt = t.Object({
	systemInstruction: t.String(),
	identity: t.String(),
	scenario: t.String(),
	exampleDialogue: t.String(),
	postHistoryInstruction: t.String(),
});

const characterDeletionMode = t.Union([
	t.Literal("hard-delete"),
	t.Literal("tombstone"),
]);

// Derived deletion impact presented with every authoritative read so the
// confirmation flow can show the exact consequence before any command.
const characterDeletionImpact = t.Object({
	provenanceReferenceCount: t.Integer(),
	deletionMode: characterDeletionMode,
});

export const characterSnapshot = t.Object({
	id: t.Integer(),
	name: t.String(),
	revision: t.Integer(),
	pinned: t.Boolean(),
	prompt: characterPrompt,
	openings: t.Array(t.String()),
	deletionImpact: characterDeletionImpact,
});

// Outcome of a confirmed deletion: the mode is derived from the reference
// count at command time, never guessed by the client.
const characterDeletionResult = t.Object({
	characterId: t.Integer(),
	deletionMode: characterDeletionMode,
});

const createCommand = t.Object({
	type: t.Literal("create"),
	definition: t.Object({
		name: t.String(),
		prompt: characterPrompt,
		openings: t.Array(t.String()),
	}),
});

const renameCommand = t.Object({
	type: t.Literal("rename"),
	characterId: t.Integer(),
	expectedRevision: t.Integer(),
	name: t.String(),
});

const replacePromptCommand = t.Object({
	type: t.Literal("replace-prompt"),
	characterId: t.Integer(),
	expectedRevision: t.Integer(),
	prompt: characterPrompt,
});

const replaceOpeningsCommand = t.Object({
	type: t.Literal("replace-openings"),
	characterId: t.Integer(),
	expectedRevision: t.Integer(),
	openings: t.Array(t.String()),
});

const setPinnedCommand = t.Object({
	type: t.Literal("set-pinned"),
	characterId: t.Integer(),
	expectedRevision: t.Integer(),
	pinned: t.Boolean(),
});

// Confirmed deletion. The expected revision guards against deleting a
// Character whose impact the caller has not seen; the outcome derives the
// deletion mode from the current reference count.
const deleteCommand = t.Object({
	type: t.Literal("delete"),
	characterId: t.Integer(),
	expectedRevision: t.Integer(),
});

const commandBodySchema = t.Union([
	createCommand,
	renameCommand,
	replacePromptCommand,
	replaceOpeningsCommand,
	setPinnedCommand,
	deleteCommand,
]);

// Thin typed adapters over the Character Library seam. The database is
// injected so tests can mount the same routes against a temporary store;
// production passes undefined to use the default connection per request.
export const createCharacterLibraryRoutes = (database: Database | undefined) =>
	new Elysia()
		.get(
			"/api/characters",
			() => ({
				characters: withCharacterLibrary(database, (library) => library.list()),
			}),
			{
				response: t.Object({ characters: t.Array(characterLibrarySummary) }),
			},
		)
		.get(
			"/api/characters/:id",
			({ params, status }) => {
				const character = withCharacterLibrary(database, (library) =>
					library.get(params.id),
				);
				if (character === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				return toCharacterPayload(character);
			},
			{
				params: t.Object({ id: t.Numeric() }),
				response: {
					200: characterSnapshot,
					404: t.Object({ outcome: t.Literal("not-found") }),
				},
			},
		)
		.post(
			"/api/characters/commands",
			({ body, status }) => {
				try {
					const outcome = withCharacterLibrary(database, (library) =>
						library.execute(body),
					);
					// A confirmed deletion returns the typed result rather than a
					// snapshot and neither stays readable; every other command
					// returns the authoritative updated Character. DeletionMode is
					// exclusive to the result, so the discriminant keeps the two
					// applied payloads distinct.
					if ("deletionMode" in outcome) {
						return {
							outcome: "applied" as const,
							result: {
								characterId: outcome.characterId,
								deletionMode: outcome.deletionMode,
							},
						};
					}
					return {
						outcome: "applied" as const,
						character: toCharacterPayload(outcome),
					};
				} catch (error) {
					if (error instanceof StaleCharacterRevisionError) {
						return status(409, {
							outcome: "conflict" as const,
							expectedRevision: error.expectedRevision,
							actualRevision: error.actualRevision,
							currentCharacter: toCharacterPayload(error.currentCharacter),
						});
					}
					if (error instanceof CharacterNotFoundError) {
						return status(404, { outcome: "not-found" as const });
					}
					if (
						error instanceof InvalidCharacterDefinitionError ||
						error instanceof InvalidCharacterCommandError
					) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				body: commandBodySchema,
				response: {
					200: t.Union([
						t.Object({
							outcome: t.Literal("applied"),
							character: characterSnapshot,
						}),
						t.Object({
							outcome: t.Literal("applied"),
							result: characterDeletionResult,
						}),
					]),
					409: t.Object({
						outcome: t.Literal("conflict"),
						expectedRevision: t.Integer(),
						actualRevision: t.Integer(),
						currentCharacter: characterSnapshot,
					}),
					404: t.Object({ outcome: t.Literal("not-found") }),
					422: t.Object({ outcome: t.Literal("invalid"), reason: t.String() }),
				},
			},
		);

