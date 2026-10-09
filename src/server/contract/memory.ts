import { presentDomainError } from "./domain-error";
import { readSelectedHistory } from "../conversation";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";

import { mergeMemoryLabels, setMemoryIdentity } from "../memory/label-commands";
import { cancelMemoryCatchup, correctMemorySource, readConversationMemories, readConversationMemoryChanges, readLatestMemoryCatchup,
	readMemoryAllowance, readMemoryTrace, resetAndReextractMemorySource, retryMemorySourceIndex, setMemoryAllowance, setMemoryNote,
	startMemoryCatchup } from "../memory/collections";
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

const cancelCatchupResponse = { 200: memoryCatchupCancelled, 422: invalidOutcome };

const startCatchupResponse = { 200: memoryCatchupQueued, 422: invalidOutcome };

const queueCollectionResponse = { 200: memoryQueued, 409: memoryCollectionConflict, 422: invalidOutcome };

const correctCollectionResponse = { 200: memoryCorrectionApplied, 409: memoryCollectionConflict, 422: invalidOutcome };

const allowanceResponse = { 200: conversationMemoryAllowanceApplied, 409: conversationMemoryAllowanceConflict, 422: invalidOutcome };

const labelsResponse = { 200: memoryLabelsMerged, 409: memoryLabelsConflict, 422: invalidOutcome };

export const createMemoryRoutes = (database: Database) => new Elysia()
	.get("/api/conversations/:id/memories", ({ params }) => readConversationMemories(database, params.id), { params: memoryConversationIdParams, response: conversationMemories })
	.get("/api/conversations/:id/memories/changes", ({ params, query }) => readConversationMemoryChanges(database, params.id, query.since),
		{ params: memoryConversationIdParams, query: memoryChangesQuery, response: conversationMemoryChanges })
	.post("/api/conversations/:id/memories/identity", ({ params, body }) => {
		try {
			setMemoryIdentity(database, params.id, body);
			return { outcome: "applied" as const, memories: readConversationMemories(database, params.id) };
		} catch (error) {
			return presentDomainError(error, labelsResponse);
		}
	}, { params: memoryConversationIdParams, body: memoryIdentityCommand, response: labelsResponse })
	.post("/api/conversations/:id/memories/merge-labels", ({ params, body }) => {
		try {
			mergeMemoryLabels(database, params.id, body);
			return { outcome: "applied" as const, memories: readConversationMemories(database, params.id) };
		} catch (error) {
			return presentDomainError(error, labelsResponse);
		}
	}, { params: memoryConversationIdParams, body: memoryLabelMergeCommand, response: labelsResponse })
	.get("/api/conversations/:id/memories/:variantId/trace", ({ params }) => ({ steps: readMemoryTrace(database, params.id, params.variantId) }), { params: memoryTraceParams, response: memoryTrace })
	.get("/api/conversations/:id/memory-allowance", ({ params }) => readMemoryAllowance(database, params.id), { params: memoryConversationIdParams, response: conversationMemoryAllowance })
	.post("/api/conversations/:id/memory-allowance", ({ params, body }) => {
		try {
			return { outcome: "applied" as const, settings: setMemoryAllowance(database, params.id, body.expectedRevision, body.allowance) };
		} catch (error) {
			return presentDomainError(error, allowanceResponse);
		}
	}, { params: memoryConversationIdParams, body: conversationMemoryAllowanceCommand, response: allowanceResponse })
	.post("/api/conversations/:id/memory-note", ({ params, body }) => {
		try {
			return { outcome: "applied" as const, settings: setMemoryNote(database, params.id, body.expectedRevision, body.note) };
		} catch (error) {
			return presentDomainError(error, allowanceResponse);
		}
	}, { params: memoryConversationIdParams, body: conversationMemoryNoteCommand, response: allowanceResponse })
	.post("/api/conversations/:id/memories/reextract", ({ params, body }) => {
		try {
			const collection = resetAndReextractMemorySource(database, params.id, body.messageId, body.variantId, body.expectedRevision);
			return { outcome: "queued" as const, collection };
		} catch (error) {
			return presentDomainError(error, queueCollectionResponse);
		}
	}, { params: memoryConversationIdParams, body: memorySourceTarget, response: queueCollectionResponse })
	.post("/api/conversations/:id/memories/correct", ({ params, body }) => {
		try {
			const collection = correctMemorySource(database, params.id, body);
			return { outcome: "applied" as const, collection };
		} catch (error) {
			return presentDomainError(error, correctCollectionResponse);
		}
	}, { params: memoryConversationIdParams, body: memoryCorrectionCommand, response: correctCollectionResponse })
	.post("/api/conversations/:id/memories/indexing/retry", ({ params, body }) => {
		try {
			const collection = retryMemorySourceIndex(database, params.id, body.messageId, body.variantId, body.expectedRevision);
			return { outcome: "queued" as const, collection };
		} catch (error) {
			return presentDomainError(error, queueCollectionResponse);
		}
	}, { params: memoryConversationIdParams, body: memorySourceTarget, response: queueCollectionResponse })
	.get("/api/conversations/:id/memories/catchup", ({ params }) => ({ run: readLatestMemoryCatchup(database, params.id) }), { params: memoryConversationIdParams, response: memoryCatchupRead })
	.post("/api/conversations/:id/memories/catchup", ({ params }) => {
		try {
			const conversationId = params.id;
			// @approved
			//  The selected path is composed here from Conversation's own
			// read model, invoked inside startMemoryCatchup's transaction, and
			// mapped onto Memory's captured-message contract.
			const run = startMemoryCatchup(database, conversationId, () => {
				const history = readSelectedHistory(database, conversationId);
				return history === undefined ? undefined : history.messages.flatMap((message) => message.variant === null ? [] : [{ messageId: message.id,
					variantId: message.variant.id, speaker: message.author?.capturedName ?? null, content: message.variant.content }]);
			});
			return { outcome: "queued" as const, run };
		}
		catch (error) {
			return presentDomainError(error, startCatchupResponse);
		}
	}, { params: memoryConversationIdParams, body: memoryCatchupCommand, response: startCatchupResponse })
	.delete("/api/conversations/:id/memories/catchup/:runId", ({ params }) => {
		try { return { outcome: "cancelled" as const, run: cancelMemoryCatchup(database, params.id, params.runId) }; }
		catch (error) {
			return presentDomainError(error, cancelCatchupResponse);
		}
	}, { params: memoryCatchupParams, response: cancelCatchupResponse });
