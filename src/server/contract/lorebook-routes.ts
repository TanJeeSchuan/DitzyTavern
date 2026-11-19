import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { isSillyTavernJsonValue } from "../prompt-preset";

import {
	executeLorebookCommand,
	importNativeLorebook,
	importSillyTavernLorebook,
	listLorebooks,
	readLorebook,
	readNativeLorebook,
} from "../lorebook/library";

import {
	bookIdParams,
	lorebookReadResponse,
	lorebookCommandBody,
	lorebookCommandResponse,
	lorebookExportResponse,
	lorebookImportResponse,
	lorebookListResponse,
	loreMatchTestBody,
	loreMatchTestResponse,
	nativeLorebook,
	sillyTavernLorebookImportBody,
	loreAttachmentQuery,
	loreAttachmentStateResponse,
	lorebookAttachmentImpactResponse,
	lorebookOwnerAttachmentQuery,
	lorebookOwnerAttachmentResponse,
} from "../../shared/contract/lorebook";
import type { LoreMatchTestResponse } from "../../shared/contract/lorebook";
import {
	readLorebookAttachmentState,
	readLorebookAttachmentImpact,
	readCharacterLorebookAttachments,
	readParticipantLorebookAttachments,
} from "../lorebook/attachments";
import { matchLoreEntry } from "../lorebook/matching";
import { captureSemanticSettings, evaluateSemanticLore } from "../lorebook/semantic";
import { invalidResponse, notFoundResponse } from "./responses";
import type { ConnectionSettingsModuleOptions } from "../connection-settings";
import type { ModelFetch } from "../model-client/types";

export interface LorebookRouteOptions extends ConnectionSettingsModuleOptions {
	readonly fetch?: ModelFetch;
}

export const createLorebookRoutes = (database: Database, options: LorebookRouteOptions = {}) => new Elysia()
	.get("/api/lorebooks", () => ({ books: listLorebooks(database) }), { response: lorebookListResponse })
	.get("/api/lorebooks/:bookId", ({ params }) => {
		const book = readLorebook(database, params.bookId);
		return book ?? notFoundResponse();
	}, { params: bookIdParams, response: lorebookReadResponse })
	.get("/api/lorebooks/:bookId/export", ({ params }) => {
		const book = readNativeLorebook(database, params.bookId);
		return book ?? notFoundResponse();
	}, { params: bookIdParams, response: lorebookExportResponse })
	.post("/api/lorebooks/import", ({ body }) => {
		try {
			return { outcome: "applied" as const, book: importNativeLorebook(database, body), warnings: [] };
		} catch (error) {
			return presentDomainError(error, lorebookImportResponse);
		}
	}, { body: nativeLorebook, response: lorebookImportResponse })
	.post("/api/lorebooks/import/sillytavern", ({ body }) => {
		if (!isSillyTavernJsonValue(body.source)) return invalidResponse("SillyTavern lorebook JSON must be valid JSON.");
		try {
			const { book, warnings } = importSillyTavernLorebook(database, body.source);
			return { outcome: "applied" as const, book, warnings };
		} catch (error) {
			return presentDomainError(error, lorebookImportResponse);
		}
	}, { body: sillyTavernLorebookImportBody, response: lorebookImportResponse })
	.post("/api/lorebooks/commands", ({ body }) => {
		try {
			const value = executeLorebookCommand(database, body);
			return "deleted" in value
				? { outcome: "deleted" as const, bookId: value.deleted }
				: { outcome: "applied" as const, book: value };
		} catch (error) {
			return presentDomainError(error, lorebookCommandResponse);
		}
	}, { body: lorebookCommandBody, response: lorebookCommandResponse })
	.post("/api/lorebooks/match-test", async ({ body, status: respond }) => {
		const book = readLorebook(database, body.bookId);
		if (book === undefined) return respond(404, { outcome: "not-found" as const });
		const scan = [{ id: null, content: body.writing }];
		const semantic = await evaluateSemanticLore({
			entries: book.entries,
			messages: scan,
			settings: captureSemanticSettings(database, options),
			fetch: options.fetch,
		});
		return respond(200, {
			mode: book.entries.length === 0 ? "none" as const : semantic.available ? "semantic" as const : "keyword-fallback" as const,
			fallbackReason: semantic.fallbackReason,
			scan,
			// @approved
			//  SAFETY: the match flattens onto the entry item (the schema owns
			// the item shape, not a nested `match` envelope) and the wire schema
			// owns mutable expression arrays, so the closed JSON projection is the
			// one cast validated by the declared response schema.
			matches: book.entries.map((entry) => ({
				bookId: book.id,
				bookName: book.name,
				entryId: entry.id,
				title: entry.title,
				...matchLoreEntry(entry, scan, semantic),
			}) as LoreMatchTestResponse["matches"][number]),
		});
	}, { body: loreMatchTestBody, response: loreMatchTestResponse })
	.use(createLorebookAttachmentRoutes(database));

const createLorebookAttachmentRoutes = (database: Database) => new Elysia()
	.get("/api/lorebooks/attachments", ({ query }) => {
		const state = readLorebookAttachmentState(database, query.conversationId);
		return state ?? notFoundResponse();
	}, { query: loreAttachmentQuery, response: loreAttachmentStateResponse })
	.get("/api/lorebooks/:bookId/attachments", ({ params }) => {
		const impact = readLorebookAttachmentImpact(database, params.bookId);
		return impact ?? notFoundResponse();
	}, { params: bookIdParams, response: lorebookAttachmentImpactResponse })
	.get("/api/lorebooks/attachments/character", ({ query }) => {
		const state = readCharacterLorebookAttachments(database, query.ownerId);
		return state ?? notFoundResponse();
	}, { query: lorebookOwnerAttachmentQuery, response: lorebookOwnerAttachmentResponse })
	.get("/api/lorebooks/attachments/participant", ({ query }) => {
		const state = readParticipantLorebookAttachments(database, query.ownerId);
		return state ?? notFoundResponse();
	}, { query: lorebookOwnerAttachmentQuery, response: lorebookOwnerAttachmentResponse });
