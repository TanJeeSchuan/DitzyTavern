import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { withDatabase } from "../database/database";
import { cancelMemoryCatchup, correctMemorySource, readConversationMemories, readLatestMemoryCatchup, readMemoryAllowance, readMemoryTrace, resetAndReextractMemorySource, retryMemorySourceIndex, setMemoryAllowance, startMemoryCatchup, StaleMemoryAllowanceError, StaleMemoryCollectionError } from "../memory/collections";
import {
	conversationMemories, conversationMemoryAllowance, conversationMemoryAllowanceApplied, memoryConversationIdParams,
	conversationMemoryAllowanceCommand, conversationMemoryAllowanceConflict, conversationMemoryAllowanceInvalid,
	memoryInvalid, memoryQueueApplied, memorySourceCommand,
	memoryCorrectionCommand, memoryCorrectionApplied, memoryCorrectionConflict,
	memoryIndexRetryCommand, memoryIndexRetryApplied, memoryIndexRetryConflict,
	memoryCatchup, memoryCatchupCommand, memoryCatchupParams, memoryCatchupRead, memoryTrace, memoryTraceParams,
} from "../../shared/contract/memory";

export const createMemoryRoutes = (database: Database | undefined) => new Elysia()
	.get("/api/conversations/:id/memories", ({ params }) => withDatabase(database, (db) => ({ sources: readConversationMemories(db, Number(params.id)) })), { params: memoryConversationIdParams, response: conversationMemories })
	.get("/api/conversations/:id/memories/:variantId/trace", ({ params }) => withDatabase(database, (db) => ({ steps: readMemoryTrace(db, Number(params.id), Number(params.variantId)) })), { params: memoryTraceParams, response: memoryTrace })
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
	}, { params: memoryConversationIdParams, body: memorySourceCommand, response: { 200: memoryQueueApplied, 422: memoryInvalid } })
	.post("/api/conversations/:id/memories/correct", ({ params, body }) => {
		try {
			const collection = withDatabase(database, (db) => correctMemorySource(db, Number(params.id), body.messageId, body.variantId, body.expectedRevision, body.index, body.operation, body.operation === "edit" ? { claim: body.claim ?? "", attribution: body.attribution ?? "", people: body.people ?? [] } : undefined));
			return { outcome: "applied" as const, collection };
		} catch (error) {
			if (error instanceof StaleMemoryCollectionError) return status(409, { outcome: "conflict" as const, collection: error.collection });
			return status(422, { outcome: "invalid" as const, reason: error instanceof Error ? error.message : "Memory correction could not be saved." });
		}
	}, { params: memoryConversationIdParams, body: memoryCorrectionCommand, response: { 200: memoryCorrectionApplied, 409: memoryCorrectionConflict, 422: memoryInvalid } })
	.post("/api/conversations/:id/memories/indexing/retry", ({ params, body }) => {
		try {
			const collection = withDatabase(database, (db) => retryMemorySourceIndex(db, Number(params.id), body.messageId, body.variantId, body.expectedRevision));
			return { outcome: "queued" as const, collection };
		} catch (error) {
			if (error instanceof StaleMemoryCollectionError) return status(409, { outcome: "conflict" as const, collection: error.collection });
			return status(422, { outcome: "invalid" as const, reason: error instanceof Error ? error.message : "Memory indexing could not be retried." });
		}
	}, { params: memoryConversationIdParams, body: memoryIndexRetryCommand, response: { 200: memoryIndexRetryApplied, 409: memoryIndexRetryConflict, 422: memoryInvalid } })
	.get("/api/conversations/:id/memories/catchup", ({ params }) => ({ run: withDatabase(database, (db) => readLatestMemoryCatchup(db, Number(params.id))) }), { params: memoryConversationIdParams, response: memoryCatchupRead })
	.post("/api/conversations/:id/memories/catchup", ({ params }) => {
		try { return withDatabase(database, (db) => startMemoryCatchup(db, Number(params.id))); }
		catch (error) { return status(422, { outcome: "invalid" as const, reason: error instanceof Error ? error.message : "History catch-up could not be started." }); }
	}, { params: memoryConversationIdParams, body: memoryCatchupCommand, response: { 200: memoryCatchup, 422: memoryInvalid } })
	.delete("/api/conversations/:id/memories/catchup/:runId", ({ params }) => {
		try { return withDatabase(database, (db) => cancelMemoryCatchup(db, Number(params.id), Number(params.runId))); }
		catch (error) { return status(422, { outcome: "invalid" as const, reason: error instanceof Error ? error.message : "History catch-up could not be cancelled." }); }
	}, { params: memoryCatchupParams, response: { 200: memoryCatchup, 422: memoryInvalid } });
