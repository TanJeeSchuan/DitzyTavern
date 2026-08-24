import type { Database } from "bun:sqlite";
import { Elysia, t } from "elysia";
import {
	CharacterNotFoundError,
	InvalidCharacterCommandError,
	InvalidCharacterDefinitionError,
} from "../../server/character-library";
import { InvalidConversationCreationError } from "../../server/conversation";
import {
	StagedChatImportDuplicateConfirmationError,
	StagedChatImportExpiredError,
	StagedChatImportPlanError,
	StagedChatImportTokenMismatchError,
	StagedChatImportUnavailableError,
	SillyTavernImportError,
	withChatImport,
	withChatImportDetails,
} from "../../server/sillytavern";
import {
	conversationSummary,
	invalidOutcome,
	notFoundOutcome,
	toConversationSummary,
} from "./conversation-schema";

const importSuggestion = t.Object({
	characterId: t.Integer(),
	name: t.String(),
	match: t.Union([
		t.Literal("exact"),
		t.Literal("case-insensitive"),
		t.Literal("fuzzy"),
	]),
	// The strongest suggestion is always pre-filled but unconfirmed; final
	// review cannot pass until the user approves it.
	confirmed: t.Boolean(),
});

const importGroup = t.Object({
	key: t.String(),
	isBlank: t.Boolean(),
	messagePositions: t.Array(t.Integer()),
	// Parallel per-Message Variant counts for inspection and split selection.
	messageVariantCounts: t.Array(t.Integer()),
	messageCount: t.Integer(),
	variantCount: t.Integer(),
	participantNameDefault: t.String(),
	suggestion: t.Nullable(importSuggestion),
});

const importDuplicateMatch = t.Object({
	id: t.Integer(),
	name: t.String(),
});

// The staged preview contract mirrors the deep SillyTavern Import module's
// public preview; routes only transport it.
const chatImportPreview = t.Object({
	title: t.String(),
	originalFilename: t.String(),
	sha256: t.String(),
	byteLength: t.Integer(),
	integrity: t.Nullable(t.String()),
	counts: t.Object({
		messages: t.Integer(),
		variants: t.Integer(),
	}),
	warnings: t.Array(t.String()),
	groups: t.Array(importGroup),
	duplicates: t.Object({
		exact: t.Array(importDuplicateMatch),
		related: t.Array(importDuplicateMatch),
	}),
});

const stagedOutcome = t.Object({
	outcome: t.Literal("staged"),
	token: t.String(),
	preview: chatImportPreview,
});

// User-confirmed resolution plan for the commit: three outcomes only, whole
// Messages referenced by 1-based record positions, and a nonblank native
// name per Participant (derived from the selected Profile for forks).
const importResolutionOutcome = t.Union([
	t.Object({
		type: t.Literal("fork"),
		characterId: t.Integer(),
	}),
	t.Object({ type: t.Literal("new-character") }),
	t.Object({ type: t.Literal("chat-only") }),
]);

const importResolvedParticipant = t.Object({
	name: t.String(),
	outcome: importResolutionOutcome,
	messagePositions: t.Array(t.Integer()),
});

const chatImportCommitBody = t.Object({
	// The SHA-256 the client already knows from the preview; only the exact
	// staged bytes that produced the preview may be committed.
	sha256: t.String(),
	title: t.String(),
	// Explicit Import another copy confirmation, required for exact
	// duplicates (matching raw-byte SHA-256); related-source matches stay
	// advisory.
	duplicateConfirmed: t.Boolean(),
	participants: t.Array(importResolvedParticipant),
});

// Receipt participant outcome labels: existing Profile fork, new Profile
// creation, or a complete Chat-only Participant.
const importReceiptParticipant = t.Object({
	name: t.String(),
	outcome: t.Union([
		t.Literal("fork"),
		t.Literal("new-character"),
		t.Literal("chat-only"),
	]),
	sourceCharacterId: t.Nullable(t.Integer()),
});

// Compact post-commit receipt; the committed Conversation summary is
// returned too so the client can open the new Chat immediately without a
// round trip, without ever shipping its Messages or provenance over the
// wire.
const chatImportReceipt = t.Object({
	conversationId: t.Integer(),
	title: t.String(),
	originalFilename: t.String(),
	sha256: t.String(),
	byteLength: t.Integer(),
	counts: t.Object({
		messages: t.Integer(),
		variants: t.Integer(),
	}),
	participants: t.Array(importReceiptParticipant),
	warnings: t.Array(t.String()),
	duplicates: t.Object({
		exact: t.Array(importDuplicateMatch),
		related: t.Array(importDuplicateMatch),
	}),
});

const commitOutcome = t.Object({
	outcome: t.Literal("committed"),
	conversation: conversationSummary,
	receipt: chatImportReceipt,
});

// Derived, never stored: whether the physical exact-source copy currently
// satisfies the committed metadata. Missing or corrupt files report cleaned
// up so provenance loss never makes the native Chat look corrupt.
const importDetailsArtifactAvailability = t.Union([
	t.Object({ status: t.Literal("available") }),
	t.Object({
		status: t.Literal("cleaned-up"),
		reason: t.Union([t.Literal("missing"), t.Literal("corrupt")]),
	}),
]);

const importDetailsArtifact = t.Object({
	chatId: t.Integer(),
	namespace: t.String(),
	key: t.String(),
	relativePath: t.String(),
	originalFilename: t.String(),
	mediaType: t.String(),
	byteLength: t.Integer(),
	sha256: t.String(),
	availability: importDetailsArtifactAvailability,
});

// The complete Import Details payload: the persisted receipt and source
// identity, structured duplicate evidence, and exact-artifact availability.
// Heavy provenance (archive text, reasoning, signatures, exact bytes) is
// never part of this contract; exact bytes load only through the download
// route.
const chatImportDetails = t.Object({
	conversationId: t.Integer(),
	title: t.String(),
	receipt: t.Object({
		originalFilename: t.String(),
		sha256: t.String(),
		byteLength: t.Nullable(t.Integer()),
		integrity: t.Nullable(t.String()),
		counts: t.Object({
			messages: t.Integer(),
			variants: t.Integer(),
		}),
		warnings: t.Array(t.String()),
		importerVersion: t.String(),
	}),
	duplicates: t.Object({
		exact: t.Array(importDuplicateMatch),
		related: t.Array(importDuplicateMatch),
	}),
	artifact: t.Nullable(importDetailsArtifact),
});

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
					200: stagedOutcome,
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
				params: t.Object({ token: t.String() }),
				body: t.Object({ sha256: t.String() }),
				response: {
					200: t.Object({
						outcome: t.Literal("available"),
						preview: chatImportPreview,
					}),
					410: t.Union([
						t.Object({ outcome: t.Literal("expired") }),
						t.Object({
							outcome: t.Literal("unavailable"),
							reason: t.Union([
								t.Literal("missing"),
								t.Literal("corrupt"),
							]),
						}),
					]),
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
				params: t.Object({ token: t.String() }),
				body: chatImportCommitBody,
				response: {
					200: commitOutcome,
					410: t.Union([
						t.Object({ outcome: t.Literal("expired") }),
						t.Object({
							outcome: t.Literal("unavailable"),
							reason: t.Union([
								t.Literal("missing"),
								t.Literal("corrupt"),
							]),
						}),
					]),
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
				params: t.Object({ token: t.String() }),
				response: {
					200: t.Object({ outcome: t.Literal("discarded") }),
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
				params: t.Object({ id: t.Numeric() }),
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
				params: t.Object({ id: t.Numeric() }),
				response: {
					404: notFoundOutcome,
					410: t.Object({
						outcome: t.Literal("cleaned-up"),
						reason: t.Union([
							t.Literal("missing"),
							t.Literal("corrupt"),
						]),
					}),
				},
			},
		);
