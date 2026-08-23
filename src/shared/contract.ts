import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import {
	CharacterNotFoundError,
	InvalidCharacterCommandError,
	InvalidCharacterDefinitionError,
	type CharacterSnapshot,
	StaleCharacterRevisionError,
	withCharacterLibrary,
} from "../server/character-library";
import { getWorkspace } from "../server/database/workspace";

// Typed transport schemas mirror the Character Library seam's public types.
// Routes stay thin adapters: persistence and validation rules live behind
// the deep module, never here.

// Adapts the seam's immutable snapshot into the transport shape.
const toCharacterPayload = (character: CharacterSnapshot) => ({
	...character,
	openings: [...character.openings],
});

const chatSummary = t.Object({
	id: t.Integer(),
	name: t.String(),
	creationTime: t.String(),
	lastMessageTime: t.String(),
	characterIds: t.Array(t.Integer()),
});

const characterSummary = t.Object({
	id: t.Integer(),
	name: t.String(),
});

const characterLibrarySummary = t.Object({
	id: t.Integer(),
	name: t.String(),
	revision: t.Integer(),
	pinned: t.Boolean(),
});

const characterPrompt = t.Object({
	systemInstruction: t.String(),
	identity: t.String(),
	scenario: t.String(),
	exampleDialogue: t.String(),
	postHistoryInstruction: t.String(),
});

const characterSnapshot = t.Object({
	id: t.Integer(),
	name: t.String(),
	revision: t.Integer(),
	pinned: t.Boolean(),
	prompt: characterPrompt,
	openings: t.Array(t.String()),
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

const commandBodySchema = t.Union([
	createCommand,
	renameCommand,
	replacePromptCommand,
	replaceOpeningsCommand,
	setPinnedCommand,
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
					const character = withCharacterLibrary(database, (library) =>
						library.execute(body),
					);
					return {
						outcome: "applied" as const,
						character: toCharacterPayload(character),
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
					200: t.Object({
						outcome: t.Literal("applied"),
						character: characterSnapshot,
					}),
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

export const contract = new Elysia()
	.get("/api/health", () => ({ ok: true }), {
		response: t.Object({ ok: t.Boolean() }),
	})
	.get("/api/workspace", () => getWorkspace(), {
		response: t.Object({
			activeChatId: t.Nullable(t.Integer()),
			chats: t.Array(chatSummary),
			characters: t.Array(characterSummary),
		}),
	})
	.use(createCharacterLibraryRoutes(undefined));

export type Contract = typeof contract;
