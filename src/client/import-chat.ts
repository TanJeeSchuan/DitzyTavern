// @approved
//  The staged Chat import transport boundary: upload once, preview against
// the token the client holds, commit, or discard. Outcomes mirror the
// server's typed results so the view recovers without re-uploading.

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
// transport already binds into every request.
export type ChatImportCommitInput = Omit<ChatImportCommitBody, "sha256">;

// @approved
//  The stage route deliberately declares no body schema so Elysia leaves the
// raw request stream untouched: `bytes` passes through the fetch init and
// only the leaf `originalFilename` rides the request header.
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
//  The client supplies the token and the SHA-256 it already knows, so a
// preview can never be fetched against different bytes.
export async function previewImport(token: string, sha256: string) {
	return requestOutcome(
		api.api["imports"].chats({ token }).preview.post({ sha256 }),
		importPreviewResponse,
		chatImportCommandErrors,
	);
}

// @approved
//  A lost commit response can be retried with the same payload and returns
// the same committed result.
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
//  The route declares no error envelopes, so the best-effort request carries
// no outcome the caller classifies.
export async function discardImport(token: string): Promise<void> {
	await api.api["imports"].chats({ token }).discard.post(undefined);
}

// @approved
//  Null handles and lost discard requests are successful no-ops (a lost
// discard leaves only an uncommitted temporary staging file behind).
export const discardStagedImport = (token: string | null): void => {
	if (token === null) return;
	void discardImport(token);
};
