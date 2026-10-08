import type { ConversationSummary } from "../../conversation";
import type {
	ChatImportCommitBody,
	ChatImportDuplicateMatch,
	ChatImportGroup as ChatImportGroupContract,
	ChatImportPreview as ChatImportPreviewContract,
	ChatImportReceipt as ChatImportReceiptContract,
	ChatImportReceiptParticipant as ChatImportReceiptParticipantContract,
	ChatImportResolvedParticipant,
	ChatImportSuggestion,
	ImportResolutionOutcome as ImportResolutionOutcomeContract,
} from "../../../shared/contract/chat-import";

// Compact post-commit receipt shared with the HTTP contract.
export type ChatImportReceipt = ChatImportReceiptContract;
export type ChatImportReceiptParticipant = ChatImportReceiptParticipantContract;
export type { ChatImportDuplicateMatch, ChatImportSuggestion };
export type SuggestionMatchKind = ChatImportSuggestion["match"];

export type ChatImportGroup = ChatImportGroupContract;
// The full staged preview. Everything here is derived from the exact
// uploaded bytes and existing library/import state; previewing creates no
// native or global domain record.
export type ChatImportPreview = ChatImportPreviewContract;

export interface StagedChatImportResult {
	token: string;
	preview: ChatImportPreview;
}

// The three resolution outcomes a resulting Participant may take: fork an
// existing Actor Profile into an independent Conversation-local Participant,
// create a Participant together with a minimal new Actor Profile, or keep a
// complete Chat-only Participant. No skip, source-role inference, or later
// re-assignment alternative exists.
export type ImportResolutionOutcome = ImportResolutionOutcomeContract;

// One resulting Participant in the user-confirmed resolution plan. Whole
// Messages are referenced by their 1-based record positions; every retained
// Message must belong to exactly one Participant and none may be skipped.
// The source author strings themselves are never part of the plan: preserved
// import data keeps the exact captured values regardless of grouping.
export type ChatImportResolvedParticipantPlan = ChatImportResolvedParticipant;

export type ChatImportCommitInput = ChatImportCommitBody;

export type ChatImportResolvedOutcome = ChatImportReceiptParticipant["outcome"];

export interface ChatImportCommitResult {
	conversation: ConversationSummary;
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
	// Managed artifact root of the deployment; staged bytes live at their
	// final unique managed path inside it, until the commit transaction
	// claims the path or the expiring sweep collects it unclaimed.
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
	// the exact staged bytes that produced the preview are committed: the
	// immutable staged managed path becomes the final artifact path, and the
	// Chat, requested new Profiles, Participants, Roster membership,
	// Author Stamps, Messages, Variants, canonical archive, report, and
	// artifact metadata commit as one all-or-nothing SQLite operation through
	// public domain seams, with the transaction claiming the staged path in
	// place (the artifact metadata row references it; no file finalization
	// precedes the database operation). A token succeeds at most once:
	// retrying after a lost response returns the original successful result
	// instead of creating another Chat. Recoverable plan failures preserve
	// the staged preview and resolution choices; a database failure claims
	// nothing on disk, so the still-staged bytes keep serving a corrected
	// retry until the session expires, when the expiring sweep collects the
	// never-claimed path.
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
	// The managed relative path of the staged bytes: the final artifact
	// path that the commit transaction claims in place.
	relativePath: string;
	preview: ChatImportPreview;
}

