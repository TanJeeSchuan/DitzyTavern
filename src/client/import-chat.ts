// ==[HUMAN APPROVED]== Replaceable typed client for the staged Chat import transport adapters.
// Every view uses this single boundary: upload streams the selected bytes
// once (never a browser filesystem path), preview re-reads the bound
// preview from the token the client already holds, and discard cancels the
// flow. Outcomes mirror the server's typed results so the view can recover
// from recoverable errors without re-uploading or losing its drafts.

// ==[HUMAN APPROVED]== Payload types and wire validation both derive from the shared TypeBox
// contract: every untrusted server response is decoded against the shared
// schemas at this boundary so a malformed payload can never masquerade as
// a trusted import result.
import type {
	ChatImportCommitBody,
	ChatImportDuplicateMatch,
	ChatImportGroup,
	ChatImportPreview,
	ChatImportReceipt,
	ChatImportReceiptParticipant,
	ChatImportResolvedParticipant,
	ChatImportSuggestion,
	ImportResolutionOutcome,
} from "../shared/contract/chat-import";
import {
	importCommittedResponse,
	importGoneResponse,
	importPreviewResponse,
	importStagedResponse,
} from "../shared/contract/chat-import";
import { invalidOutcome } from "../shared/contract/outcomes";
import { decodeWirePayload } from "./lib/wire-decode";
import type { JsonValue } from "./lib/json-guards";

export type {
	ChatImportDuplicateMatch,
	ChatImportGroup,
	ChatImportPreview,
	ChatImportReceipt,
	ChatImportReceiptParticipant,
	ChatImportResolvedParticipant,
	ChatImportSuggestion,
	ImportResolutionOutcome,
};

// ==[HUMAN APPROVED]== The match kinds are the contract's closed literal union on the suggestion.
export type SuggestionMatchKind = ChatImportSuggestion["match"];

export type ChatImportStageOutcome =
	| { status: "staged"; token: string; preview: ChatImportPreview }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export type ChatImportPreviewOutcome =
	| { status: "available"; preview: ChatImportPreview }
	// ==[HUMAN APPROVED]== The flow expired (server restart or prior cancellation): reselect.
	| { status: "expired" }
	| { status: "unavailable"; reason: "missing" | "corrupt" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

// ==[HUMAN APPROVED]== The commit payload is the contract's commit body minus the SHA-256 the
// transport itself already binds into every request.
export type ChatImportCommitInput = Omit<ChatImportCommitBody, "sha256">;

// ==[HUMAN APPROVED]== The receipt's outcome labels are the contract's closed literal union.
export type ChatImportResolvedOutcome = ChatImportReceiptParticipant["outcome"];

export type ChatImportCommitOutcome =
	| { status: "committed"; conversationId: number; receipt: ChatImportReceipt }
	// ==[HUMAN APPROVED]== The flow expired or the staged bytes are gone/corrupt: reselect.
	| { status: "expired" }
	| { status: "unavailable"; reason: "missing" | "corrupt" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export interface ChatImportTransport {
	// ==[HUMAN APPROVED]== Uploads the selected bytes exactly once and receives the staged token
	// bound to the preview. `bytes` is the File/Blob the user chose; only
	// its leaf `originalFilename` travels alongside.
	stage(bytes: Blob, originalFilename: string): Promise<ChatImportStageOutcome>;
	// ==[HUMAN APPROVED]== Re-reads the bound preview for a recoverable transport error. The
	// client supplies the token and the SHA-256 it already knows, so a
	// preview can never be fetched against a different hash.
	preview(token: string, sha256: string): Promise<ChatImportPreviewOutcome>;
	// ==[HUMAN APPROVED]== Commits the confirmed resolution plan against the exact staged bytes.
	// The token and SHA-256 the client already knows bind the request to
	// the previewed source; a lost response can be retried with the same
	// payload and returns the same committed result.
	commit(
		token: string,
		sha256: string,
		input: ChatImportCommitInput,
	): Promise<ChatImportCommitOutcome>;
	// ==[HUMAN APPROVED]== Cancels the flow; only that flow's uncommitted staging data is
	// removed. Idempotent.
	discard(token: string): Promise<void>;
}

// ==[HUMAN APPROVED]== Wire decoding at the transport seam: every untrusted server response is
// validated against the shared contract schemas before any typed outcome
// leaves this boundary. Any field failing the typed contract — a missing
// field, a malformed nested value, or an unexpected top-level shape —
// fails the whole payload so a partial response can never enter the flow.

const wireBody = async (response: Response): Promise<JsonValue> =>
	await response.json().catch(() => null);

// ==[HUMAN APPROVED]== A typed invalid outcome keeps its contextual reason; an error body the
// client cannot decode normalizes to the network outcome.
const parseInvalidResponse = (
	value: JsonValue,
): Extract<ChatImportStageOutcome, { status: "invalid" | "network" }> => {
	const invalid = decodeWirePayload(invalidOutcome, value);
	return invalid === null
		? { status: "network" }
		: { status: "invalid", reason: invalid.reason };
};

// ==[HUMAN APPROVED]== The gone-state outcome shared by preview and commit: expired and
// unavailable handles both mean the staged flow is lost, so a gone body
// the client cannot decode still falls back to the expired reselect
// recovery.
const parseGoneResponse = (value: JsonValue) => {
	const gone = decodeWirePayload(importGoneResponse, value);
	return gone === null || gone.outcome === "expired"
		? { status: "expired" as const }
		: { status: "unavailable" as const, reason: gone.reason };
};

const parseStageResponse = async (
	response: Response,
): Promise<ChatImportStageOutcome> => {
	const value = await wireBody(response);
	if (!response.ok) return parseInvalidResponse(value);
	const staged = decodeWirePayload(importStagedResponse, value);
	return staged === null
		? { status: "network" }
		: { status: "staged", token: staged.token, preview: staged.preview };
};

const parsePreviewResponse = async (
	response: Response,
): Promise<ChatImportPreviewOutcome> => {
	const value = await wireBody(response);
	if (response.status === 410) return parseGoneResponse(value);
	if (!response.ok) return parseInvalidResponse(value);
	const available = decodeWirePayload(importPreviewResponse, value);
	return available === null
		? { status: "network" }
		: { status: "available", preview: available.preview };
};

const parseCommitResponse = async (
	response: Response,
): Promise<ChatImportCommitOutcome> => {
	const value = await wireBody(response);
	if (response.status === 410) return parseGoneResponse(value);
	if (!response.ok) return parseInvalidResponse(value);
	const committed = decodeWirePayload(importCommittedResponse, value);
	return committed === null
		? { status: "network" }
		: {
				status: "committed",
				conversationId: committed.receipt.conversationId,
				receipt: committed.receipt,
			};
};

export interface ChatImportTransportOptions {
	// ==[HUMAN APPROVED]== Server origin; defaults to the current page origin in the browser.
	base?: string;
	// ==[HUMAN APPROVED]== Injectable request function for tests (for example one backed by
	// app.handle). Narrower than `typeof fetch` so a plain function works.
	fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export const createChatImportTransport = (
	options: ChatImportTransportOptions = {},
): ChatImportTransport => {
	const base =
		options.base ??
		(globalThis.window === undefined
			? "http://localhost"
			: window.location.origin);
	const request = options.fetchImpl ?? ((input, init) => fetch(input, init));

	return {
		async stage(bytes, originalFilename) {
			try {
				const response = await request(`${base}/api/imports/chats/stage`, {
					method: "POST",
					headers: { "x-import-filename": originalFilename },
					body: bytes,
				});
				return await parseStageResponse(response);
			} catch {
				return { status: "network" };
			}
		},
		async preview(token, sha256) {
			try {
				const response = await request(
					`${base}/api/imports/chats/${encodeURIComponent(token)}/preview`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sha256 }),
					},
				);
				return await parsePreviewResponse(response);
			} catch {
				return { status: "network" };
			}
		},
		async commit(token, sha256, input) {
			try {
				const response = await request(
					`${base}/api/imports/chats/${encodeURIComponent(token)}/commit`,
					{
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ sha256, ...input }),
					},
				);
				return await parseCommitResponse(response);
			} catch {
				return { status: "network" };
			}
		},
		async discard(token) {
			try {
				await request(
					`${base}/api/imports/chats/${encodeURIComponent(token)}/discard`,
					{ method: "POST" },
				);
			} catch {
				// ==[HUMAN APPROVED]== Cancellation is best-effort: a lost discard leaves only an
				// uncommitted temporary staging file behind.
			}
		},
	};
};

// ==[HUMAN APPROVED]== Cancels a staged flow when a handle exists. Null handles and lost discard
// requests are successful no-ops (a lost discard leaves only an uncommitted
// temporary staging file behind). Every Back/Cancel path in the UI routes
// through this single helper.
export const discardStagedImport = (
	token: string | null,
	transport: ChatImportTransport = chatImportTransport,
): void => {
	if (token === null) return;
	void transport.discard(token);
};

// ==[HUMAN APPROVED]== The default boundary used by the Import Chat UI.
export const chatImportTransport: ChatImportTransport =
	createChatImportTransport();
