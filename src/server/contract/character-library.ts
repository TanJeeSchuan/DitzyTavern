import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import {
	createCharacterLibraryModule,
} from "../character-library";
import {
	characterCommandApplied,
	characterConflict,
	characterIdParams,
	characterListResponse,
	characterSnapshot,
	commandBodySchema,
} from "../../shared/contract/character-library";

import { invalidOutcome, notFoundOutcome } from "../../shared/contract/outcomes";

import { toCharacterPayload } from "./projections";

// @approved
//  Keep this adapter export stable for sibling route adapters that use the
// Character transport projection while the implementation lives below the
// route-adapter layer.
export { toCharacterPayload };

// @approved
//  Thin typed adapters over the Character Library seam. The database is
// injected so tests can mount the same routes against a temporary store;
// production provides the server-owned database connection.
export const createCharacterLibraryRoutes = (database: Database) =>
	new Elysia()
		.get(
			"/api/characters",
			() => ({
				characters: createCharacterLibraryModule(database).list(),
			}),
			{ response: characterListResponse },
		)
		.get(
			"/api/characters/:id",
			({ params, status }) => {
				const character = createCharacterLibraryModule(database).get(params.id);
				if (character === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				return toCharacterPayload(character);
			},
			{
				params: characterIdParams,
				response: {
					200: characterSnapshot,
					404: notFoundOutcome,
				},
			},
		)
		.post(
			"/api/characters/commands",
			({ body }) => {
				try {
					const outcome = createCharacterLibraryModule(database).execute(body);
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
					return presentDomainError(error, { 404: notFoundOutcome, 409: characterConflict, 422: invalidOutcome });
				}
			},
			{
				body: commandBodySchema,
				response: {
					200: characterCommandApplied,
					409: characterConflict,
					404: notFoundOutcome,
					422: invalidOutcome,
				},
			},
		);
