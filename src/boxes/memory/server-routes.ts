import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { presentDomainError, readExistingSources } from "@/box-sdk/server";
import { invalidOutcome } from "@/box-sdk/shared";
import {
	conversationMemories, conversationMemoryAllowance, conversationMemoryAllowanceApplied, conversationMemoryAllowanceCommand, conversationMemoryAllowanceConflict,
	conversationMemoryNoteCommand, memoryConversationIdParams, memoryIdentityCommand, memoryLabelMergeCommand, memoryLabelsConflict, memoryLabelsMerged,
	memorySettingsApplied, memorySettingsCommandBody, memorySettingsConflict, memorySettingsResponse, memorySources, memorySourcesQuery,
} from "./contract";
import { mergeMemoryLabels, readConversationMemories, setMemoryAllowance, setMemoryIdentity, setMemoryNote } from "./server-memories";
import { readMemoryChatSettings } from "./server-chat";
import { createMemorySettingsModule } from "./server-settings";

const allowanceResponse = { 200: conversationMemoryAllowanceApplied, 409: conversationMemoryAllowanceConflict, 422: invalidOutcome };
const labelsResponse = { 200: memoryLabelsMerged, 409: memoryLabelsConflict, 422: invalidOutcome };
const settingsResponse = { 200: memorySettingsApplied, 409: memorySettingsConflict, 422: invalidOutcome };
const ids = (list: string) => list === "" ? [] : list.split(",").map(Number);

// @approved
//  Memory's own reads and settings, for its side panel, its settings editor
//  and its trace view, which the host serves under `/api/boxes/memory`. Its
//  records change through the host's `set-box-record` and `reset-box-record`
//  commands, and its digests through the host's catch-up and passage digest
//  routes.
export const memoryRoutes = (database: Database) => new Elysia()
	.get("/settings", () => createMemorySettingsModule(database).get(), { response: memorySettingsResponse })
	.post("/settings/commands", ({ body }) => {
		try {
			return { outcome: "applied" as const, settings: createMemorySettingsModule(database).apply(body) };
		} catch (error) {
			return presentDomainError(error, settingsResponse);
		}
	}, { body: memorySettingsCommandBody, response: settingsResponse })
	.get("/conversations/:id/memories", ({ params }) => readConversationMemories(database, params.id), { params: memoryConversationIdParams, response: conversationMemories })
	.get("/conversations/:id/memories/sources", ({ params, query }) => readExistingSources(database, params.id, { messageIds: ids(query.messageIds), variantIds: ids(query.variantIds) }),
		{ params: memoryConversationIdParams, query: memorySourcesQuery, response: memorySources })
	.post("/conversations/:id/memories/identity", ({ params, body }) => {
		try {
			setMemoryIdentity(database, params.id, body);
			return { outcome: "applied" as const, memories: readConversationMemories(database, params.id) };
		} catch (error) {
			return presentDomainError(error, labelsResponse);
		}
	}, { params: memoryConversationIdParams, body: memoryIdentityCommand, response: labelsResponse })
	.post("/conversations/:id/memories/merge-labels", ({ params, body }) => {
		try {
			mergeMemoryLabels(database, params.id, body);
			return { outcome: "applied" as const, memories: readConversationMemories(database, params.id) };
		} catch (error) {
			return presentDomainError(error, labelsResponse);
		}
	}, { params: memoryConversationIdParams, body: memoryLabelMergeCommand, response: labelsResponse })
	.get("/conversations/:id/allowance", ({ params }) => readMemoryChatSettings(database, params.id), { params: memoryConversationIdParams, response: conversationMemoryAllowance })
	.post("/conversations/:id/allowance", ({ params, body }) => {
		try {
			return { outcome: "applied" as const, settings: setMemoryAllowance(database, params.id, body.expectedRevision, body.allowance) };
		} catch (error) {
			return presentDomainError(error, allowanceResponse);
		}
	}, { params: memoryConversationIdParams, body: conversationMemoryAllowanceCommand, response: allowanceResponse })
	.post("/conversations/:id/note", ({ params, body }) => {
		try {
			return { outcome: "applied" as const, settings: setMemoryNote(database, params.id, body.expectedRevision, body.note) };
		} catch (error) {
			return presentDomainError(error, allowanceResponse);
		}
	}, { params: memoryConversationIdParams, body: conversationMemoryNoteCommand, response: allowanceResponse });
export type MemoryRoutes = ReturnType<typeof memoryRoutes>;
