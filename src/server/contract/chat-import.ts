import { presentDomainError } from "./domain-error";
import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";

import {
	createChatImportModule,
	createChatImportDetailsModule,
} from "../sillytavern";

import { toConversationSummary } from "./projections";
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

// @approved
//  Thin typed adapters over the deep staged Chat import seam. The stage
// route deliberately declares no body schema: Elysia must leave the raw
// request stream untouched so the module can stream the uploaded bytes into
// managed temporary storage exactly once instead of buffering the artifact.
// The preview and discard routes stay tiny mappings of typed outcomes.
const commitResponse = {
	200: importCommittedResponse,
	410: importGoneResponse,
	422: invalidOutcome,
};

const previewResponse = {
	200: importPreviewResponse,
	410: importGoneResponse,
	422: invalidOutcome,
};

const stageResponse = {
	200: importStagedResponse,
	422: invalidOutcome,
};

export const createChatImportRoutes = (
	database: Database,
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
					const result = await createChatImportModule(database, { artifactDirectory: artifactDirectory }).stageFile({
								bytes: body,
								originalFilename,
							});
					return { outcome: "staged" as const, ...result };
				} catch (error) {
					return presentDomainError(error, stageResponse);
				}
			},
			{
				response: stageResponse,
			},
		)
		.post(
			"/api/imports/chats/:token/preview",
			({ params, body }) => {
				try {
					const preview = createChatImportModule(database, { artifactDirectory: artifactDirectory }).preview(params.token, body.sha256);
					return { outcome: "available" as const, preview };
				} catch (error) {
					return presentDomainError(error, previewResponse);
				}
			},
			{
				params: importTokenParams,
				body: importPreviewBody,
				response: previewResponse,
			},
		)
		.post(
			"/api/imports/chats/:token/commit",
			({ params, body }) => {
				try {
					const result = createChatImportModule(database, { artifactDirectory: artifactDirectory }).commit(params.token, {
								sha256: body.sha256,
								title: body.title,
								duplicateConfirmed: body.duplicateConfirmed,
								participants: body.participants,
							});
					return {
						outcome: "committed" as const,
						conversation: toConversationSummary(result.conversation),
						receipt: result.receipt,
					};
				} catch (error) {
					return presentDomainError(error, commitResponse);
				}
			},
			{
				params: importTokenParams,
				body: chatImportCommitBody,
				response: commitResponse,
			},
		)
		.post(
			"/api/imports/chats/:token/discard",
			({ params }) => {
				// @approved
				//  Discard is idempotent: unknown and already-discarded handles
				// report the same removed outcome without touching anything.
				createChatImportModule(database, { artifactDirectory: artifactDirectory }).discard(params.token);
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
				const details = createChatImportDetailsModule(database, artifactDirectory).importDetails(params.id);
				if (details === undefined) {
					// @approved
					//  Either the Chat is missing or it carries no import
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
				const result = createChatImportDetailsModule(database, artifactDirectory).downloadExactSource(params.id);
				if (result === undefined) {
					return status(404, { outcome: "not-found" as const });
				}
				if (result.status === "cleaned-up") {
					// @approved
					//  Missing or corrupt exact artifacts are described as cleaned
					// up and disable only exact download; normal Chat reading and
					// every Conversation command stay available.
					return status(410, {
						outcome: "cleaned-up" as const,
						reason: result.reason,
					});
				}
				// @approved
				//  The exact managed bytes stream verbatim; only response metadata
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
