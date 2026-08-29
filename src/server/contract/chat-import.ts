import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import {
	CharacterNotFoundError,
	InvalidCharacterCommandError,
	InvalidCharacterDefinitionError,
} from "../character-library";
import { InvalidConversationCreationError } from "../conversation";
import {
	StagedChatImportDuplicateConfirmationError,
	StagedChatImportExpiredError,
	StagedChatImportPlanError,
	StagedChatImportTokenMismatchError,
	StagedChatImportUnavailableError,
	SillyTavernImportError,
	withChatImport,
	withChatImportDetails,
} from "../sillytavern";
import { toConversationSummary } from "./payload";
import {
	chatImportCommitBody,
	chatImportDetails,
	importCleanedUpResponse,
	importCommittedResponse,
	importDiscardedResponse,
	importGoneResponse,
	importPreviewBody,
	importPreviewResponse,
	importStagedResponse,
	importTokenParams,
} from "../../shared/contract/chat-import";
import { conversationIdParams } from "../../shared/contract/conversation-schema";
import { invalidOutcome, notFoundOutcome } from "../../shared/contract/outcomes";

// Thin typed adapters over the deep staged Chat import seam. The stage
// route deliberately declares no body schema: Elysia must leave the raw
// request stream untouched so the module can stream the uploaded bytes into
// managed temporary storage exactly once instead of buffering the artifact.
// The preview and discard routes stay tiny mappings of typed outcomes.
export const createChatImportRoutes = (
	database: Database | undefined,
	artifactDirectory: string,
) =>
	new Elysia()
		.post(
			"/api/imports/chats/stage",
			async ({ request, status }) => {
				const originalFilename =
					request.headers.get("x-import-filename") ?? "";
				if (originalFilename === "") {
					return status(422, {
						outcome: "invalid" as const,
						reason: "A file name is required with this upload.",
					});
				}
				const body = request.body;
				if (body === null) {
					return status(422, {
						outcome: "invalid" as const,
						reason: "The upload body is empty.",
					});
				}
				try {
					const result = await withChatImport(
						database,
						artifactDirectory,
						(chatImport) =>
							chatImport.stageFile({
								bytes: body,
								originalFilename,
							}),
					);
					return { outcome: "staged" as const, ...result };
				} catch (error) {
					if (error instanceof SillyTavernImportError) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				response: {
					200: importStagedResponse,
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/imports/chats/:token/preview",
			({ params, body, status }) => {
				try {
					const preview = withChatImport(
						database,
						artifactDirectory,
						(chatImport) =>
							chatImport.preview(params.token, body.sha256),
					);
					return { outcome: "available" as const, preview };
				} catch (error) {
					if (error instanceof StagedChatImportExpiredError) {
						return status(410, { outcome: "expired" as const });
					}
					if (error instanceof StagedChatImportUnavailableError) {
						return status(410, {
							outcome: "unavailable" as const,
							reason: error.reason,
						});
					}
					if (error instanceof StagedChatImportTokenMismatchError) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				params: importTokenParams,
				body: importPreviewBody,
				response: {
					200: importPreviewResponse,
					410: importGoneResponse,
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/imports/chats/:token/commit",
			({ params, body, status }) => {
				try {
					const result = withChatImport(
						database,
						artifactDirectory,
						(chatImport) =>
							chatImport.commit(params.token, {
								sha256: body.sha256,
								title: body.title,
								duplicateConfirmed: body.duplicateConfirmed,
								participants: body.participants,
							}),
					);
					return {
						outcome: "committed" as const,
						conversation: toConversationSummary(result.conversation),
						receipt: result.receipt,
					};
				} catch (error) {
					if (error instanceof StagedChatImportExpiredError) {
						return status(410, { outcome: "expired" as const });
					}
					if (error instanceof StagedChatImportUnavailableError) {
						return status(410, {
							outcome: "unavailable" as const,
							reason: error.reason,
						});
					}
					if (
						error instanceof StagedChatImportTokenMismatchError ||
						error instanceof StagedChatImportPlanError ||
						error instanceof StagedChatImportDuplicateConfirmationError ||
						error instanceof SillyTavernImportError ||
						error instanceof CharacterNotFoundError ||
						error instanceof InvalidCharacterDefinitionError ||
						error instanceof InvalidCharacterCommandError ||
						error instanceof InvalidConversationCreationError
					) {
						return status(422, {
							outcome: "invalid" as const,
							reason: error.message,
						});
					}
					throw error;
				}
			},
			{
				params: importTokenParams,
				body: chatImportCommitBody,
				response: {
					200: importCommittedResponse,
					410: importGoneResponse,
					422: invalidOutcome,
				},
			},
		)
		.post(
			"/api/imports/chats/:token/discard",
			({ params }) => {
				// Discard is idempotent: unknown and already-discarded handles
				// report the same removed outcome without touching anything.
				withChatImport(database, artifactDirectory, (chatImport) =>
					chatImport.discard(params.token),
				);
				return { outcome: "discarded" as const };
			},
			{
				params: importTokenParams,
				response: {
					200: importDiscardedResponse,
				},
			},
		)
		.get(
			"/api/conversations/:id/import-details",
			({ params, status }) => {
				const details = withChatImportDetails(
					database,
					artifactDirectory,
					(importDetails) => importDetails.importDetails(params.id),
				);
				if (details === undefined) {
					// Either the Chat is missing or it carries no import
					// provenance; the client treats both as "no Import Details".
					return status(404, { outcome: "not-found" as const });
				}
				return details;
			},
			{
				params: conversationIdParams,
				response: {
					200: chatImportDetails,
					404: notFoundOutcome,
				},
			},
		)
		.get(
			"/api/conversations/:id/import-source",
			({ params, status }) => {
				const result = withChatImportDetails(
					database,
					artifactDirectory,
					(importDetails) =>
						importDetails.downloadExactSource(params.id),
				);
				if (result === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				if (result.status === "cleaned-up") {
					// Missing or corrupt exact artifacts are described as cleaned
					// up and disable only exact download; normal Chat reading and
					// every Conversation command stay available.
					return status(410, {
						outcome: "cleaned-up" as const,
						reason: result.reason,
					});
				}
				// The exact managed bytes stream verbatim; only response metadata
				// (media type and the sanitized original leaf filename) derives
				// from the stored artifact.
				return new Response(new Uint8Array(result.bytes), {
					headers: {
						"content-type": result.artifact.mediaType,
						"content-disposition": result.contentDisposition,
						"content-length": String(result.bytes.length),
					},
				});
			},
			{
				params: conversationIdParams,
				response: {
					404: notFoundOutcome,
					410: importCleanedUpResponse,
				},
			},
		);
