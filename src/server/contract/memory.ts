import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";

import { mergeMemoryLabels, setMemoryIdentity } from "../memory/label-commands";
import { readConversationMemories, readMemoryAllowance, setMemoryAllowance, setMemoryNote } from "../memory/memories";
import {
	conversationMemories,
	conversationMemoryAllowance,
	conversationMemoryAllowanceApplied,
	memoryConversationIdParams,
	conversationMemoryAllowanceCommand,
	conversationMemoryAllowanceConflict,
	conversationMemoryNoteCommand,
	memoryIdentityCommand,
	memoryLabelMergeCommand,
	memoryLabelsMerged,
	memoryLabelsConflict,
} from "../../shared/contract/memory";
import { invalidOutcome } from "../../shared/contract/outcomes";

const allowanceResponse = { 200: conversationMemoryAllowanceApplied, 409: conversationMemoryAllowanceConflict, 422: invalidOutcome };

const labelsResponse = { 200: memoryLabelsMerged, 409: memoryLabelsConflict, 422: invalidOutcome };

// @approved
//  Memory's own reads and per-Chat settings. Its records change through the
//  host's `set-box-record` and `reset-box-record` commands, and its digests
//  through the host's catch-up and passage digest routes.
export const createMemoryRoutes = (database: Database) => new Elysia()
	.get("/api/conversations/:id/memories", ({ params }) => readConversationMemories(database, params.id), { params: memoryConversationIdParams, response: conversationMemories })
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
	}, { params: memoryConversationIdParams, body: conversationMemoryNoteCommand, response: allowanceResponse });
