import type { ConversationSnapshot } from "../../conversation/types";

// Editable Participant-name default for blank captured author groups. The
// exact blank source value stays untouched in preserved source data; this
// name is the flow's proposed native Participant-name default.
export const UNKNOWN_IMPORTED_AUTHOR_NAME = "Unknown imported author";

export type SuggestionMatchKind = "exact" | "case-insensitive" | "fuzzy";

// The strongest name-only Character candidate for one author group. It is
// always presented as an unconfirmed pre-fill: `confirmed` starts false and
// can only become true through the user's explicit approval.
export interface ChatImportSuggestion {
	characterId: number;
	name: string;
	match: SuggestionMatchKind;
	confirmed: boolean;
}

// One initial author group keyed on the exact captured author string. Case
// and whitespace variants (and each blank captured name) stay separate
// initially; nothing is trimmed, case-folded, aliased, merged, or split.
export interface ChatImportGroup {
	// The verbatim captured author string; the empty string for blank names.
	key: string;
	isBlank: boolean;
	// 1-based record positions whose Messages belong to this group.
	messagePositions: number[];
	// Variant count of each retained Message, parallel to messagePositions,
	// so the resolver can present per-Message inspection and selection.
	messageVariantCounts: number[];
	messageCount: number;
	variantCount: number;
	// Proposed native Participant name, editable by the user. Blank groups
	// default to UNKNOWN_IMPORTED_AUTHOR_NAME; others keep the exact key.
	participantNameDefault: string;
	// Strongest name-only Character suggestion, unconfirmed; null when the
	// group (or the library) has nothing to suggest.
	suggestion: ChatImportSuggestion | null;
}

export interface ChatImportDuplicateMatch {
	id: number;
	name: string;
}

// The full staged preview. Everything here is derived from the exact
// uploaded bytes and existing library/import state; previewing creates no
// native or global domain record.
export interface ChatImportPreview {
	// Filename-derived Chat title, editable by the user before commit.
	title: string;
	originalFilename: string;
	// Raw-byte SHA-256 of the exact uploaded bytes; the binding authority.
	sha256: string;
	byteLength: number;
	// Source-declared integrity when the export carried one; advisory only.
	integrity: string | null;
	counts: { messages: number; variants: number };
	warnings: string[];
	groups: ChatImportGroup[];
	duplicates: {
		// Matching raw SHA-256: an exact duplicate of a prior import.
		exact: ChatImportDuplicateMatch[];
		// Declared-integrity-only match: a related source, not a duplicate.
		related: ChatImportDuplicateMatch[];
	};
}

export interface StagedChatImportResult {
	token: string;
	preview: ChatImportPreview;
}

// The three resolution outcomes a resulting Participant may take: fork an
// existing Actor Profile into an independent Conversation-local Participant,
// create a Participant together with a minimal new Actor Profile, or keep a
// complete Chat-only Participant. No skip, source-role inference, or later
// re-assignment alternative exists.
export type ImportResolutionOutcome =
	| { type: "fork"; characterId: number }
	| { type: "new-character" }
	| { type: "chat-only" };

// One resulting Participant in the user-confirmed resolution plan. Whole
// Messages are referenced by their 1-based record positions; every retained
// Message must belong to exactly one Participant and none may be skipped.
// The source author strings themselves are never part of the plan: preserved
// import data keeps the exact captured values regardless of grouping.
export interface ChatImportResolvedParticipantPlan {
	// Proposed native Participant name. For a fork the server derives the
	// authoritative name from the selected Profile's current name instead.
	name: string;
	outcome: ImportResolutionOutcome;
	messagePositions: number[];
}

export interface ChatImportCommitInput {
	// The SHA-256 the client already knows from the preview; only the exact
	// staged bytes that produced the preview may be committed.
	sha256: string;
	// The editable Chat title confirmed at final review.
	title: string;
	// Explicit import another copy confirmation, required only when the
	// staged source is an exact duplicate of a prior import.
	duplicateConfirmed: boolean;
	participants: ChatImportResolvedParticipantPlan[];
}

export type ChatImportResolvedOutcome = "fork" | "new-character" | "chat-only";

export interface ChatImportReceiptParticipant {
	name: string;
	outcome: ChatImportResolvedOutcome;
	sourceCharacterId: number | null;
}

// Compact post-commit receipt: what was created, under which source
// identity, with which Participants and outcomes. Receipt details also
// persist as Conversation-scoped report data; the receipt itself is the
// immediate success surface, never a badge, category, or capability flag.
export interface ChatImportReceipt {
	conversationId: number;
	title: string;
	originalFilename: string;
	sha256: string;
	byteLength: number;
	counts: { messages: number; variants: number };
	participants: ChatImportReceiptParticipant[];
	warnings: string[];
	duplicates: {
		exact: ChatImportDuplicateMatch[];
		related: ChatImportDuplicateMatch[];
	};
}

export interface ChatImportCommitResult {
	conversation: ConversationSnapshot;
	receipt: ChatImportReceipt;
}

export interface ChatImportStageInput {
	// The exact bytes streamed straight from the client; the flow never
	// receives or reopens a browser filesystem path.
	bytes: ReadableStream<Uint8Array>;
	// Original leaf filename used for the picker default, preview, and the
	// eventual preserved artifact metadata.
	originalFilename: string;
}

export interface ChatImportModuleOptions {
	// Managed artifact root of the deployment; staged bytes live under its
	// `staging/` subdirectory, separate from committed artifacts.
	artifactDirectory: string;
}

export interface ChatImportModule {
	// Uploads once: streams the bytes into managed temporary storage,
	// validates the complete source, and binds a fresh token to the exact
	// byte length and SHA-256. Throws SillyTavernImportError for contextual
	// validation failures (the staged bytes are discarded on failure).
	stageFile(input: ChatImportStageInput): Promise<StagedChatImportResult>;
	// Re-reads the preview bound to a token. The token is the only handle;
	// an unknown (expired or discarded) token and a SHA-256 that does not
	// match the binding are both rejected without altering the flow.
	preview(token: string, expectedSha256?: string): ChatImportPreview;
	// Commits the user-confirmed resolution plan for one staged handle. Only
	// the exact staged bytes that produced the preview are committed; the
	// managed exact artifact is finalized before the database operation, and
	// the Chat, requested new Profiles, Participants, Roster membership,
	// Author Stamps, Messages, Variants, canonical archive, report, and
	// artifact metadata commit as one all-or-nothing SQLite operation through
	// public domain seams. A token succeeds at most once: retrying after a
	// lost response returns the original successful result instead of
	// creating another Chat. Recoverable plan failures preserve the staged
	// preview and resolution choices; failures after the artifact is
	// finalized are non-recoverable and the flow must reselect the file.
	commit(token: string, input: ChatImportCommitInput): ChatImportCommitResult;
	// Explicit cancellation: removes the handle and deletes only that
	// flow's uncommitted staging bytes. Idempotent; unknown tokens are a
	// successful no-op.
	discard(token: string): void;
}

export interface StagedRecord {
	token: string;
	originalFilename: string;
	byteLength: number;
	sha256: string;
	integrity: string | null;
	stagedPath: string;
	preview: ChatImportPreview;
}

