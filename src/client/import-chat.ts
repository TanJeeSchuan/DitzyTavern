// @approved
//  Replaceable typed client for the staged Chat import transport adapters.
// Every view uses this single boundary: upload streams the selected bytes
// once (never a browser filesystem path), preview re-reads the bound
// preview from the token the client already holds, and discard cancels the
// flow. Outcomes mirror the server's typed results so the view can recover
// from recoverable errors without re-uploading or losing its drafts.

import { api } from "./lib/eden";
import { requestOutcome } from "./lib/request-outcome";
import {
	chatImportCommandErrors,
	importCommittedResponse,
	importPreviewResponse,
	importStagedResponse,
	type ChatImportCommitBody,
	type ChatImportReceipt,
} from "../shared/contract/chat-import";
import { invalidOutcome } from "../shared/contract/outcomes";

export type { ChatImportReceipt };

// @approved
//  The commit payload is the contract's commit body minus the SHA-256 the
// transport itself already binds into every request.
export type ChatImportCommitInput = Omit<ChatImportCommitBody, "sha256">;

// The import route family's outcome is the wire's own: the staged/available/
// committed responses under `available`, the typed 410/422 envelopes verbatim,
// and network for everything the seam could not classify.

// @approved
//  Uploads the selected bytes exactly once and receives the staged token
// bound to the preview. `bytes` is the File/Blob the user chose; only its
// leaf `originalFilename` travels alongside.
// The stage route deliberately declares no body schema so Elysia leaves the
// raw request stream untouched: the bytes pass through the fetch init and
// the leaf name rides the request header.
export async function stageImport(bytes: Blob, originalFilename: string) {
	return requestOutcome(
		api.api["imports"].chats.stage.post(
			undefined,
			{ headers: { "x-import-filename": originalFilename }, fetch: { body: bytes } },
		),
		importStagedResponse,
		invalidOutcome,
	);
}

// @approved
//  Re-reads the bound preview for a recoverable transport error. The client
// supplies the token and the SHA-256 it already knows, so a preview can
// never be fetched against a different hash.
export async function previewImport(token: string, sha256: string) {
	return requestOutcome(
		api.api["imports"].chats({ token }).preview.post({ sha256 }),
		importPreviewResponse,
		chatImportCommandErrors,
	);
}

// @approved
//  Commits the confirmed resolution plan against the exact staged bytes.
// The token and SHA-256 the client already knows bind the request to the
// previewed source; a lost response can be retried with the same payload
// and returns the same committed result.
export async function commitImport(
	token: string,
	sha256: string,
	input: ChatImportCommitInput,
) {
	return requestOutcome(
		api.api["imports"].chats({ token }).commit.post({ sha256, ...input }),
		importCommittedResponse,
		chatImportCommandErrors,
	);
}

// @approved
//  Cancels the flow; only that flow's uncommitted staging data is removed.
// Idempotent.
// The route declares no error envelopes, so the best-effort request carries
// no outcome the caller classifies.
export async function discardImport(token: string): Promise<void> {
	await api.api["imports"].chats({ token }).discard.post(undefined);
}

// @approved
//  Cancels a staged flow when a handle exists. Null handles and lost discard
// requests are successful no-ops (a lost discard leaves only an uncommitted
// temporary staging file behind). Every Back/Cancel path in the UI routes
// through this single helper.
export const discardStagedImport = (token: string | null): void => {
	if (token === null) return;
	void discardImport(token);
};
