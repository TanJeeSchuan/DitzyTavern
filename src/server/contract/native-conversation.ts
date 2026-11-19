import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";

import { createNativeConversation } from "../workflows";

import { toConversationSummary } from "./projections";
import {
	nativeConversationBody,
	nativeConversationResponse,
} from "../../shared/contract/native-conversation";

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
				return presentDomainError(error, nativeConversationResponse);
			}
		},
		{
			body: nativeConversationBody,
			response: nativeConversationResponse,
		},
	);
