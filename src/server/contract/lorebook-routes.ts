import type { Database } from "bun:sqlite";
import { Elysia, status } from "elysia";
import { isSillyTavernJsonValue } from "../prompt-preset";
import type { SillyTavernJsonValue } from "../../shared/contract/prompt-preset";
import { withDatabase } from "../database/database";
import {
	executeLorebookCommand,
	importNativeLorebook,
	importSillyTavernLorebook,
	listLorebooks,
	readLorebook,
	readNativeLorebook,
} from "../lorebook/library";
import {
	InvalidLorebookCommandError,
	LorebookEntryNotFoundError,
	LorebookNotFoundError,
	StaleLorebookRevisionError,
} from "../lorebook/errors";
import {
	bookIdParams,
	lorebook,
	lorebookCommandBody,
	lorebookCommandResponse,
	lorebookConflict,
	lorebookImportApplied,
	lorebookListResponse,
	loreMatchTestBody,
	loreMatchTestResponse,
	nativeLorebook,
	sillyTavernLorebookImportBody,
	loreAttachmentCommandBody,
	loreAttachmentCommandResponse,
	loreAttachmentQuery,
	loreAttachmentState,
} from "../../shared/contract/lorebook";
import {
	attachLorebookToCharacter,
	attachLorebookToParticipant,
	attachLorebookToConversation,
	detachLorebookFromCharacter,
	detachLorebookFromParticipant,
	detachLorebookFromConversation,
	readLorebookAttachmentState,
	saveLoreSettings,
} from "../lorebook/attachments";
import { evaluateScopedLoreAsync } from "../lorebook/evaluation";
import { readSelectedHistory } from "../conversation/selected-history";
import { invalidOutcome, notFoundOutcome } from "../../shared/contract/outcomes";
import { invalidResponse, notFoundResponse } from "./responses";

const classify = (cause: unknown) => {
	if (cause instanceof LorebookNotFoundError || cause instanceof LorebookEntryNotFoundError) return { outcome: "not-found" as const };
	if (cause instanceof InvalidLorebookCommandError) return { outcome: "invalid" as const, reason: cause.message };
	if (cause instanceof StaleLorebookRevisionError) return {
		outcome: "conflict" as const,
		reason: "stale-revision" as const,
		expectedRevision: cause.expectedRevision,
		actualRevision: cause.actualRevision,
		currentBook: cause.currentBook,
	};
	return null;
};

const execute = <T>(operation: () => T) => {
	try { return { ok: true as const, value: operation() }; } catch (cause) {
		const failure = classify(cause);
		if (failure !== null) return { ok: false as const, failure };
		throw cause;
	}
};

export const createLorebookRoutes = (database: Database | undefined) => new Elysia()
	.get("/api/lorebooks", () => ({ books: withDatabase(database, listLorebooks) }), { response: lorebookListResponse })
	.get("/api/lorebooks/:bookId", ({ params }) => {
		const book = withDatabase(database, (connection) => readLorebook(connection, params.bookId));
		return book ?? notFoundResponse();
	}, { params: bookIdParams, response: { 200: lorebook, 404: notFoundOutcome } })
	.get("/api/lorebooks/:bookId/export", ({ params }) => {
		const book = withDatabase(database, (connection) => readNativeLorebook(connection, params.bookId));
		return book ?? notFoundResponse();
	}, { params: bookIdParams, response: { 200: nativeLorebook, 404: notFoundOutcome } })
	.post("/api/lorebooks/import", ({ body }) => {
		const result = execute(() => withDatabase(database, (connection) => importNativeLorebook(connection, body)));
		if (!result.ok) return result.failure.outcome === "invalid" ? invalidResponse(result.failure.reason) : notFoundResponse();
		return { outcome: "applied" as const, book: result.value, warnings: [] };
	}, { body: nativeLorebook, response: { 200: lorebookImportApplied, 404: notFoundOutcome, 422: invalidOutcome } })
	.post("/api/lorebooks/import/sillytavern", ({ body }) => {
		if (!isSillyTavernJsonValue(body.source)) return invalidResponse("SillyTavern lorebook JSON must be valid JSON.");
		// ==[HUMAN APPROVED]== SAFETY: the guard above proves the opaque request value is valid JSON at this boundary.
		const result = execute(() => withDatabase(database, (connection) => importSillyTavernLorebook(connection, body.source as SillyTavernJsonValue)));
		if (!result.ok) return result.failure.outcome === "invalid" ? invalidResponse(result.failure.reason) : notFoundResponse();
		return { outcome: "applied" as const, book: result.value.book, warnings: result.value.warnings };
	}, { body: sillyTavernLorebookImportBody, response: { 200: lorebookImportApplied, 404: notFoundOutcome, 422: invalidOutcome } })
	.post("/api/lorebooks/commands", ({ body }) => {
		const result = execute(() => withDatabase(database, (connection) => executeLorebookCommand(connection, body)));
		if (!result.ok) {
			if (result.failure.outcome === "not-found") return notFoundResponse();
			if (result.failure.outcome === "invalid") return invalidResponse(result.failure.reason);
			return status(409, result.failure);
		}
		return "deleted" in result.value
			? { outcome: "deleted" as const, bookId: result.value.deleted }
			: { outcome: "applied" as const, book: result.value };
	}, { body: lorebookCommandBody, response: { 200: lorebookCommandResponse, 404: notFoundOutcome, 409: lorebookConflict, 422: invalidOutcome } })
	.post("/api/lorebooks/match-test", async ({ body, status: respond }) => {
		const result = await withDatabase(database, async (connection) => {
			const history = readSelectedHistory(connection, body.conversationId);
			if (history === undefined) return undefined;
			return evaluateScopedLoreAsync({
				database: connection,
				conversationId: body.conversationId,
				messages: history.messages.flatMap((message) => message.variant === null ? [] : [{ id: message.id, content: message.variant.content }]),
				pendingHumanText: body.writing,
			});
		});
		if (result === undefined) return respond(404, { outcome: "not-found" as const });
		return respond(200, {
			mode: result.activation.mode,
			fallbackReason: result.activation.mode === "keyword-fallback"
				? result.matches.find((item) => item.match.semantic.fallbackReason !== undefined)?.match.semantic.fallbackReason
				: undefined,
			scan: result.scan.map((message) => ({ id: message.id ?? null, content: message.content })),
			matches: result.matches.map(({ bookId, bookName, entryId, title, match }) => ({
				bookId, bookName, entryId, title,
				active: match.active,
				skipped: match.skipped,
				fallback: match.fallback,
				primary: { ...match.primary, matchedExpressions: [...match.primary.matchedExpressions], missingExpressions: [...match.primary.missingExpressions] },
				secondary: {
					requireAny: { ...match.secondary.requireAny, matchedExpressions: [...match.secondary.requireAny.matchedExpressions], missingExpressions: [...match.secondary.requireAny.missingExpressions] },
					requireAll: { ...match.secondary.requireAll, matchedExpressions: [...match.secondary.requireAll.matchedExpressions], missingExpressions: [...match.secondary.requireAll.missingExpressions] },
					excludeAny: { ...match.secondary.excludeAny, matchedExpressions: [...match.secondary.excludeAny.matchedExpressions], missingExpressions: [...match.secondary.excludeAny.missingExpressions] },
					excludeAll: { ...match.secondary.excludeAll, matchedExpressions: [...match.secondary.excludeAll.matchedExpressions], missingExpressions: [...match.secondary.excludeAll.missingExpressions] },
				},
				semantic: { ...match.semantic, matches: match.semantic.matches.map((semanticMatch) => ({ ...semanticMatch })) },
				reasons: [...match.reasons],
			})),
		});
	}, { body: loreMatchTestBody, response: { 200: loreMatchTestResponse, 404: notFoundOutcome } })
	.use(createLorebookAttachmentRoutes(database));

export const createLorebookAttachmentRoutes = (database: Database | undefined) => new Elysia()
	.get("/api/lorebooks/attachments", ({ query }) => {
		const state = withDatabase(database, (connection) => readLorebookAttachmentState(connection, query.conversationId));
		return state ?? notFoundResponse();
	}, { query: loreAttachmentQuery, response: { 200: loreAttachmentState, 404: notFoundOutcome } })
	.post("/api/lorebooks/attachments/commands", ({ body }) => {
		withDatabase(database, (connection) => {
			const command = body;
			switch (command.type) {
				case "attach-character": return attachLorebookToCharacter(connection, command);
				case "attach-participant": return attachLorebookToParticipant(connection, command);
				case "attach-chat": return attachLorebookToConversation(connection, { conversationId: command.conversationId, bookId: command.bookId, enabled: command.enabled });
				case "detach-character": return detachLorebookFromCharacter(connection, command.characterId, command.bookId);
				case "detach-participant": return detachLorebookFromParticipant(connection, command.participantId, command.bookId);
				case "detach-chat": return detachLorebookFromConversation(connection, command.conversationId, command.bookId);
				case "save-settings": return saveLoreSettings(connection, command.conversationId, { scanDepth: command.scanDepth, allowance: command.allowance });
			}
		});
		return { outcome: "applied" as const };
	}, { body: loreAttachmentCommandBody, response: { 200: loreAttachmentCommandResponse } });
