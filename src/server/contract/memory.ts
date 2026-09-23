import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { withDatabase } from "../database/database";
import { readConversationMemories, readMemoryAllowance, resetAndReextractMemorySource, setMemoryAllowance, StaleMemoryAllowanceError } from "../memory/collections";
import {
	conversationMemories, conversationMemoryAllowance, conversationMemoryAllowanceApplied, memoryConversationIdParams,
	conversationMemoryAllowanceCommand, conversationMemoryAllowanceConflict, conversationMemoryAllowanceInvalid,
	memoryInvalid, memoryQueueApplied, memorySourceCommand,
} from "../../shared/contract/memory";

export const createMemoryRoutes = (database: Database | undefined) => new Elysia()
	.get("/api/conversations/:id/memories", ({ params }) => withDatabase(database, (db) => ({ sources: readConversationMemories(db, Number(params.id)) })), { params: memoryConversationIdParams, response: conversationMemories })
	.get("/api/conversations/:id/memory-allowance", ({ params }) => withDatabase(database, (db) => readMemoryAllowance(db, Number(params.id))), { params: memoryConversationIdParams, response: conversationMemoryAllowance })
	.post("/api/conversations/:id/memory-allowance", ({ params, body }) => {
		try {
			return { outcome: "applied" as const, settings: withDatabase(database, (db) => setMemoryAllowance(db, Number(params.id), body.expectedRevision, body.allowance)) };
		} catch (error) {
			if (error instanceof StaleMemoryAllowanceError) return status(409, { outcome: "conflict" as const, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision, currentSettings: error.currentSettings });
			return status(422, { outcome: "invalid" as const, reason: error instanceof Error ? error.message : "Memory Allowance could not be saved." });
		}
	}, { params: memoryConversationIdParams, body: conversationMemoryAllowanceCommand, response: { 200: conversationMemoryAllowanceApplied, 409: conversationMemoryAllowanceConflict, 422: conversationMemoryAllowanceInvalid } })
	.post("/api/conversations/:id/memories/reextract", ({ params, body }) => {
		try {
			const collection = withDatabase(database, (db) => resetAndReextractMemorySource(db, Number(params.id), body.messageId));
			return { outcome: "queued" as const, collection };
		} catch (error) {
			return status(422, { outcome: "invalid" as const, reason: error instanceof Error ? error.message : "Memory work could not be queued." });
		}
	}, { params: memoryConversationIdParams, body: memorySourceCommand, response: { 200: memoryQueueApplied, 422: memoryInvalid } });
