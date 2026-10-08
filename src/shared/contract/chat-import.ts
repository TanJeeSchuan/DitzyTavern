import { Type, type Static } from "@sinclair/typebox";
import { conversationSummary } from "./conversation-schema";
import { invalidOutcome } from "./outcomes";

const importSuggestion = Type.Object({
	characterId: Type.Integer(),
	name: Type.String(),
	match: Type.Union([
		Type.Literal("exact"),
		Type.Literal("case-insensitive"),
		Type.Literal("fuzzy"),
	]),
	// The strongest suggestion is always pre-filled but unconfirmed; final
	// review cannot pass until the user approves it.
	confirmed: Type.Boolean(),
});

export type ChatImportSuggestion = Static<typeof importSuggestion>;

const importGroup = Type.Object({
	// The verbatim captured author string; the empty string for blank names.
	key: Type.String(),
	isBlank: Type.Boolean(),
	messagePositions: Type.Array(Type.Integer()),
	// Variant count of each retained Message, parallel to messagePositions.
	messageVariantCounts: Type.Array(Type.Integer()),
	messageCount: Type.Integer(),
	variantCount: Type.Integer(),
	// Proposed native Participant name, editable by the user.
	participantNameDefault: Type.String(),
	suggestion: Type.Union([Type.Null(), importSuggestion]),
});

export type ChatImportGroup = Static<typeof importGroup>;

const importDuplicateMatch = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
});

export type ChatImportDuplicateMatch = Static<typeof importDuplicateMatch>;

// Duplicate evidence: the classified Prior imports for one source, exact
// (matching raw-byte SHA-256) or related (matching only the advisory
// integrity). Shared by the preview, receipt, and Import Details payloads.
export const duplicateEvidence = Type.Object({
	exact: Type.Array(importDuplicateMatch),
	related: Type.Array(importDuplicateMatch),
});

export type ChatImportDuplicateEvidence = Static<typeof duplicateEvidence>;

// The two ways an Exact Source Artifact copy can be missing content;
// missing or corrupt copies report cleaned up without affecting the Chat.
export const cleanupReason = Type.Union([
	Type.Literal("missing"),
	Type.Literal("corrupt"),
]);

export type ImportCleanupReason = Static<typeof cleanupReason>;

// The staged preview contract mirrors the deep SillyTavern Import module's
// public preview; routes only transport it.
const chatImportPreview = Type.Object({
	title: Type.String(),
	originalFilename: Type.String(),
	sha256: Type.String(),
	byteLength: Type.Integer(),
	integrity: Type.Union([Type.Null(), Type.String()]),
	counts: Type.Object({
		messages: Type.Integer(),
		variants: Type.Integer(),
	}),
	warnings: Type.Array(Type.String()),
	groups: Type.Array(importGroup),
	duplicates: duplicateEvidence,
});

export type ChatImportPreview = Static<typeof chatImportPreview>;

const stagedOutcome = Type.Object({
	outcome: Type.Literal("staged"),
	token: Type.String(),
	preview: chatImportPreview,
});

// User-confirmed resolution plan for the commit: three outcomes only, whole
// Messages referenced by 1-based record positions, and a nonblank native
// name per Participant (derived from the selected Profile for forks).
// The three resolution outcomes a resulting Participant may take. No skip,
// source-role inference, or later re-assignment alternative exists.
const importResolutionOutcome = Type.Union([
	Type.Object({
		type: Type.Literal("fork"),
		characterId: Type.Integer(),
	}),
	Type.Object({ type: Type.Literal("new-character") }),
	Type.Object({ type: Type.Literal("chat-only") }),
]);

export type ImportResolutionOutcome = Static<typeof importResolutionOutcome>;

// One resulting Participant of the user-confirmed resolution plan. Whole
// Messages are referenced by their 1-based record positions.
const importResolvedParticipant = Type.Object({
	name: Type.String(),
	outcome: importResolutionOutcome,
	messagePositions: Type.Array(Type.Integer()),
});

export type ChatImportResolvedParticipant = Static<typeof importResolvedParticipant>;

export const chatImportCommitBody = Type.Object({
	// The SHA-256 the client already knows from the preview; only the exact
	// staged bytes that produced the preview may be committed.
	sha256: Type.String(),
	title: Type.String(),
	// Explicit Import another copy confirmation, required for exact
	// duplicates (matching raw-byte SHA-256); related-source matches stay
	// advisory.
	duplicateConfirmed: Type.Boolean(),
	participants: Type.Array(importResolvedParticipant),
});

export type ChatImportCommitBody = Static<typeof chatImportCommitBody>;

// Receipt participant outcome labels: existing Profile fork, new Profile
// creation, or a complete Chat-only Participant.
const importReceiptParticipant = Type.Object({
	name: Type.String(),
	outcome: Type.Union([
		Type.Literal("fork"),
		Type.Literal("new-character"),
		Type.Literal("chat-only"),
	]),
	sourceCharacterId: Type.Union([Type.Null(), Type.Integer()]),
});

export type ChatImportReceiptParticipant = Static<typeof importReceiptParticipant>;

// Compact post-commit receipt; the committed Conversation summary is
// returned too so the client can open the new Chat immediately without a
// round trip, without ever shipping its Messages or provenance over the
// wire.
const chatImportReceipt = Type.Object({
	conversationId: Type.Integer(),
	title: Type.String(),
	originalFilename: Type.String(),
	sha256: Type.String(),
	byteLength: Type.Integer(),
	counts: Type.Object({
		messages: Type.Integer(),
		variants: Type.Integer(),
	}),
	participants: Type.Array(importReceiptParticipant),
	warnings: Type.Array(Type.String()),
	duplicates: duplicateEvidence,
});

export type ChatImportReceipt = Static<typeof chatImportReceipt>;

export const importCommittedResponse = Type.Object({
	outcome: Type.Literal("committed"),
	conversation: conversationSummary,
	receipt: chatImportReceipt,
});

// Derived, never stored: whether the physical exact-source copy currently
// satisfies the committed metadata. Missing or corrupt files report cleaned
// up so provenance loss never makes the native Chat look corrupt.
const importDetailsArtifactAvailability = Type.Union([
	Type.Object({ status: Type.Literal("available") }),
	Type.Object({
		status: Type.Literal("cleaned-up"),
		reason: cleanupReason,
	}),
]);

export type ImportDetailsArtifactAvailability = Static<typeof importDetailsArtifactAvailability>;

// @approved
//  The committed metadata of one preserved exact-source artifact:
// (namespace, key) identity within the Conversation, managed placement, and
// content digest. Neutral shared home for the 7-field schema so the
// Conversation creation seam and the wire artifact shape both derive from
// one declaration instead of restating it.
export const artifactMetadata = Type.Object({
	namespace: Type.String(),
	key: Type.String(),
	// Path relative to the managed artifact directory of the deployment.
	relativePath: Type.String(),
	// The original leaf filename carried by the source, used verbatim for
	// presentation; response metadata is sanitized on download only.
	originalFilename: Type.String(),
	mediaType: Type.String(),
	byteLength: Type.Integer(),
	// Raw-byte SHA-256: the authoritative content digest of the exact stored
	// bytes, sensitive to BOM, line endings, whitespace, escape spelling,
	// blank lines, and trailing newline.
	sha256: Type.String(),
});

// @approved
//  The wire artifact shape adds the owning Chat and the derived
// availability on top of the committed metadata.
const importDetailsArtifact = Type.Composite([
	artifactMetadata,
	Type.Object({
		chatId: Type.Integer(),
		availability: importDetailsArtifactAvailability,
	}),
]);

export type ImportDetailsArtifact = Static<typeof importDetailsArtifact>;

// The complete readable Import Details payload: the persisted receipt and
// source identity, structured duplicate evidence, and exact-artifact
// availability. Heavy provenance (archive text, reasoning, signatures,
// exact bytes) is never part of this contract; exact bytes load only through
// the download route.
const readableChatImportDetails = Type.Object({
	provenanceState: Type.Literal("readable"),
	conversationId: Type.Integer(),
	title: Type.String(),
	receipt: Type.Object({
		originalFilename: Type.String(),
		sha256: Type.String(),
		byteLength: Type.Union([Type.Null(), Type.Integer()]),
		integrity: Type.Union([Type.Null(), Type.String()]),
		counts: Type.Object({
			messages: Type.Integer(),
			variants: Type.Integer(),
		}),
		warnings: Type.Array(Type.String()),
		importerVersion: Type.String(),
	}),
	duplicates: duplicateEvidence,
	artifact: Type.Union([Type.Null(), importDetailsArtifact]),
});

// A persisted report entry can outlive its ability to decode. Keep that
// state distinct from absent provenance so the Chat information surface can
// explain the loss while ordinary Conversation reads remain available.
const unreadableChatImportDetails = Type.Object({
	provenanceState: Type.Literal("unreadable"),
	conversationId: Type.Integer(),
	title: Type.String(),
});

export const chatImportDetails = Type.Union([
	readableChatImportDetails,
	unreadableChatImportDetails,
]);

export type ChatImportDetails = Static<typeof chatImportDetails>;

// Route boundary schemas referenced by the Chat Import adapter: the stage
// route deliberately declares no body schema so Elysia leaves the raw
// request stream untouched and the module can stream uploaded bytes into
// managed temporary storage exactly once.

export const importTokenParams = Type.Object({ token: Type.String() });

export const importPreviewBody = Type.Object({ sha256: Type.String() });

export const importStagedResponse = stagedOutcome;

export const importPreviewResponse = Type.Object({
	outcome: Type.Literal("available"),
	preview: chatImportPreview,
});

// Expired and unavailable staged handles are both gone-state 410 outcomes.
export const importGoneResponse = Type.Union([
	Type.Object({ outcome: Type.Literal("expired") }),
	Type.Object({
		outcome: Type.Literal("unavailable"),
		reason: cleanupReason,
	}),
]);

export const importDiscardedResponse = Type.Object({
	outcome: Type.Literal("discarded"),
});

export const importCleanedUpResponse = Type.Object({
	outcome: Type.Literal("cleaned-up"),
	reason: cleanupReason,
});

// @approved
//  The Chat Import command family's modeled error union: the composed
// 410/422 envelopes every staged route declares, so the client decodes an
// error body against exactly that union.
export const chatImportCommandErrors = Type.Union([
	importGoneResponse,
	invalidOutcome,
]);
