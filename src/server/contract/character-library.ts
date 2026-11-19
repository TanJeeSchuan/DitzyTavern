import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import {
	createCharacterLibraryModule,
} from "../character-library";
import {
	characterCommandResponse,
	characterIdParams,
	characterListResponse,
	characterReadResponse,
	commandBodySchema,
} from "../../shared/contract/character-library";

import { toCharacterPayload } from "./projections";

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
				response: characterReadResponse,
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
					return presentDomainError(error, characterCommandResponse);
				}
			},
			{
				body: commandBodySchema,
				response: characterCommandResponse,
			},
		);
