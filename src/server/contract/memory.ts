import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";

import { mergeMemoryLabels, setMemoryIdentity } from "../memory/labels";
import { cancelMemoryCatchup, correctMemorySource, readConversationMemories, readConversationMemoryChanges, readLatestMemoryCatchup, readMemoryAllowance, readMemoryTrace, resetAndReextractMemorySource, retryMemorySourceIndex, setMemoryAllowance, setMemoryNote, startMemoryCatchup } from "../memory/collections";
import { createConversationModule } from "../conversation";
import {
	conversationMemories,
	conversationMemoryAllowance,
	conversationMemoryAllowanceApplied,
	conversationMemoryChanges,
	memoryChangesQuery,
	memoryConversationIdParams,
	conversationMemoryAllowanceCommand,
	conversationMemoryAllowanceConflict,
	conversationMemoryNoteCommand,
	memoryQueued,
	memoryCollectionConflict,
	memorySourceTarget,
	memoryCorrectionCommand,
	memoryCorrectionApplied,
	memoryIdentityCommand,
	memoryLabelMergeCommand,
	memoryLabelsMerged,
	memoryLabelsConflict,
	memoryCatchupQueued,
	memoryCatchupCancelled,
	memoryCatchupCommand,
	memoryCatchupParams,
	memoryCatchupRead,
	memoryTrace,
	memoryTraceParams,
} from "../../shared/contract/memory";
import { invalidOutcome } from "../../shared/contract/outcomes";

export const createMemoryRoutes = (database: Database) => new Elysia()
	.get("/api/conversations/:id/memories", ({ params }) => readConversationMemories(database, Number(params.id)), { params: memoryConversationIdParams, response: conversationMemories })
	.get("/api/conversations/:id/memories/changes", ({ params, query }) => readConversationMemoryChanges(database, Number(params.id), query.since), { params: memoryConversationIdParams, query: memoryChangesQuery, response: conversationMemoryChanges })
	.post("/api/conversations/:id/memories/identity", ({ params, body }) => {
		try {
			setMemoryIdentity(database, Number(params.id), body);
			return { outcome: "applied" as const, memories: readConversationMemories(database, Number(params.id)) };
		} catch (error) {
			return presentDomainError(error, { 409: memoryLabelsConflict, 422: invalidOutcome }, { memories: () => readConversationMemories(database, Number(params.id)) });
		}
	}, { params: memoryConversationIdParams, body: memoryIdentityCommand, response: { 200: memoryLabelsMerged, 409: memoryLabelsConflict, 422: invalidOutcome } })
	.post("/api/conversations/:id/memories/merge-labels", ({ params, body }) => {
		try {
			mergeMemoryLabels(database, Number(params.id), body);
			return { outcome: "applied" as const, memories: readConversationMemories(database, Number(params.id)) };
		} catch (error) {
			return presentDomainError(error, { 409: memoryLabelsConflict, 422: invalidOutcome }, { memories: () => readConversationMemories(database, Number(params.id)) });
		}
	}, { params: memoryConversationIdParams, body: memoryLabelMergeCommand, response: { 200: memoryLabelsMerged, 409: memoryLabelsConflict, 422: invalidOutcome } })
	.get("/api/conversations/:id/memories/:variantId/trace", ({ params }) => ({ steps: readMemoryTrace(database, Number(params.id), Number(params.variantId)) }), { params: memoryTraceParams, response: memoryTrace })
	.get("/api/conversations/:id/memory-allowance", ({ params }) => readMemoryAllowance(database, Number(params.id)), { params: memoryConversationIdParams, response: conversationMemoryAllowance })
	.post("/api/conversations/:id/memory-allowance", ({ params, body }) => {
		try {
			return { outcome: "applied" as const, settings: setMemoryAllowance(database, Number(params.id), body.expectedRevision, body.allowance) };
		} catch (error) {
			return presentDomainError(error, { 409: conversationMemoryAllowanceConflict, 422: invalidOutcome });
		}
	}, { params: memoryConversationIdParams, body: conversationMemoryAllowanceCommand, response: { 200: conversationMemoryAllowanceApplied, 409: conversationMemoryAllowanceConflict, 422: invalidOutcome } })
	.post("/api/conversations/:id/memory-note", ({ params, body }) => {
		try {
			return { outcome: "applied" as const, settings: setMemoryNote(database, Number(params.id), body.expectedRevision, body.note) };
		} catch (error) {
			return presentDomainError(error, { 409: conversationMemoryAllowanceConflict, 422: invalidOutcome });
		}
	}, { params: memoryConversationIdParams, body: conversationMemoryNoteCommand, response: { 200: conversationMemoryAllowanceApplied, 409: conversationMemoryAllowanceConflict, 422: invalidOutcome } })
	.post("/api/conversations/:id/memories/reextract", ({ params, body }) => {
		try {
			const collection = resetAndReextractMemorySource(database, Number(params.id), body.messageId, body.variantId, body.expectedRevision);
			return { outcome: "queued" as const, collection };
		} catch (error) {
			return presentDomainError(error, { 409: memoryCollectionConflict, 422: invalidOutcome });
		}
	}, { params: memoryConversationIdParams, body: memorySourceTarget, response: { 200: memoryQueued, 409: memoryCollectionConflict, 422: invalidOutcome } })
	.post("/api/conversations/:id/memories/correct", ({ params, body }) => {
		try {
			const collection = correctMemorySource(database, Number(params.id), body);
			return { outcome: "applied" as const, collection };
		} catch (error) {
			return presentDomainError(error, { 409: memoryCollectionConflict, 422: invalidOutcome });
		}
	}, { params: memoryConversationIdParams, body: memoryCorrectionCommand, response: { 200: memoryCorrectionApplied, 409: memoryCollectionConflict, 422: invalidOutcome } })
	.post("/api/conversations/:id/memories/indexing/retry", ({ params, body }) => {
		try {
			const collection = retryMemorySourceIndex(database, Number(params.id), body.messageId, body.variantId, body.expectedRevision);
			return { outcome: "queued" as const, collection };
		} catch (error) {
			return presentDomainError(error, { 409: memoryCollectionConflict, 422: invalidOutcome });
		}
	}, { params: memoryConversationIdParams, body: memorySourceTarget, response: { 200: memoryQueued, 409: memoryCollectionConflict, 422: invalidOutcome } })
	.get("/api/conversations/:id/memories/catchup", ({ params }) => ({ run: readLatestMemoryCatchup(database, Number(params.id)) }), { params: memoryConversationIdParams, response: memoryCatchupRead })
	.post("/api/conversations/:id/memories/catchup", ({ params }) => {
		try {
			const conversationId = Number(params.id);
			// @approved
			//  The selected path is composed here from Conversation's own
			// read model, invoked inside startMemoryCatchup's transaction, and
			// mapped onto Memory's captured-message contract.
			const run = startMemoryCatchup(database, conversationId, () => {
				const history = createConversationModule(database).readSelectedHistory(conversationId);
				return history === undefined ? undefined : history.messages.flatMap((message) => message.variant === null ? [] : [{ messageId: message.id, variantId: message.variant.id, speaker: message.author?.capturedName ?? null, content: message.variant.content }]);
			});
			return { outcome: "queued" as const, run };
		}
		catch (error) {
			return presentDomainError(error, { 422: invalidOutcome });
		}
	}, { params: memoryConversationIdParams, body: memoryCatchupCommand, response: { 200: memoryCatchupQueued, 422: invalidOutcome } })
	.delete("/api/conversations/:id/memories/catchup/:runId", ({ params }) => {
		try { return { outcome: "cancelled" as const, run: cancelMemoryCatchup(database, Number(params.id), Number(params.runId)) }; }
		catch (error) {
			return presentDomainError(error, { 422: invalidOutcome });
		}
	}, { params: memoryCatchupParams, response: { 200: memoryCatchupCancelled, 422: invalidOutcome } });
