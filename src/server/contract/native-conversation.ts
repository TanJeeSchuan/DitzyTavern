import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";

import { createNativeConversation } from "../workflows";

import { toConversationSummary } from "./projections";
import { characterConflict } from "../../shared/contract/character-library";
import {
	nativeConversationBody,
	nativeConversationResponse,
} from "../../shared/contract/native-conversation";
import { invalidOutcome, notFoundOutcome } from "../../shared/contract/outcomes";

const createResponse = {
	200: nativeConversationResponse,
	409: characterConflict,
	404: notFoundOutcome,
	422: invalidOutcome,
};

export const createNativeConversationRoutes = (database: Database) =>
	new Elysia().post(
		"/api/conversations/native",
		({ body }) => {
			try {
				const conversation = createNativeConversation(database, {
						name: body.name,
						humanSeat: body.humanSeat,
						modelSeat: body.modelSeat,
						timeZone: body.timeZone,
						locale: body.locale,
					});
				return {
					outcome: "created" as const,
					conversation: toConversationSummary(conversation),
				};
			} catch (error) {
				return presentDomainError(error, createResponse);
			}
		},
		{
			body: nativeConversationBody,
			response: createResponse,
		},
	);
