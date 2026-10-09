// @approved
// Replaceable typed client boundary for reading a Chat's native history and
//  its Import Details. Every view uses this single boundary: pagination,
// receipt loading, heavy provenance, and artifact download stay behind typed
// operations instead of embedding transport behavior throughout Message
// components.
// The paginated read model is the normal Chat read: stable chronological
// pages of native Messages with Participant identity, immutable Author
// Stamp names, Variant order, selected Variant state, and persisted Reasoning
// Content. Exact artifact bytes, the canonical archive text, and signatures
// stay behind deliberate detail operations.

import { api } from "./lib/eden";
import { requestOutcome } from "./lib/request-outcome";
import { decodeWirePayload } from "./lib/wire-decode";
import type {
	ChatHistoryMessage,
	ChatHistoryPage,
	ChatHistoryVariant,
} from "../shared/contract/conversation-schema";
import { chatHistoryPage } from "../shared/contract/conversation-schema";
import {
	chatImportDetails,
	importCleanedUpResponse,
} from "../shared/contract/chat-import";
import type { ChatImportDetails } from "../shared/contract/chat-import";
import { notFoundOutcome } from "../shared/contract/outcomes";

export type {
	ChatHistoryMessage,
	ChatHistoryPage,
	ChatHistoryVariant,
};
export type { ChatImportDetails };

export interface ChatHistoryPageRequest {
	aroundMessageId?: number;
	// @approved
	// 1-based page within the stable position-ordered chronology, counted
	//  backward from the newest Message (page 1 = latest window).
	page?: number;
}

// @approved
// Exact-source download outcome. Missing or corrupt exact artifacts are a
//  typed cleaned-up result: only exact download is affected, never normal
// Chat reading or commands.
export type ChatSourceDownloadOutcome =
	| { outcome: "available"; filename: string; mediaType: string; bytes: Uint8Array }
	| { outcome: "cleaned-up"; reason: "missing" | "corrupt" }
	| { outcome: "not-found" }
	| { outcome: "network" };

// Reads one stable chronological page of native Messages; the outcome is
// the wire's own: the page under `available`, the typed 404 envelope
// verbatim, network when the transport could not complete the request, and
// the shared invalid fallback when the response could not be read.
export async function loadHistoryPage(
	conversationId: number,
	request?: ChatHistoryPageRequest,
	signal?: AbortSignal,
) {
	return requestOutcome(
		api.api.conversations({ id: conversationId }).history.get({
			query: { page: request?.page, aroundMessageId: request?.aroundMessageId },
			fetch: { signal },
		}),
		chatHistoryPage,
		notFoundOutcome,
	);
}

// @approved
// Loads the persisted receipt and source identity for one Chat; a typed
//  not-found for Chats without import provenance.
export async function loadImportDetails(conversationId: number) {
	return requestOutcome(
		api.api.conversations({ id: conversationId })["import-details"].get(),
		chatImportDetails,
		notFoundOutcome,
	);
}

// The exact-source base targets like the Eden boundary: the page origin in
// the browser, a local default where the browser object is absent.
const importSourceBase =
	globalThis.window === undefined ? "http://localhost" : window.location.origin;

// The exact-source download is this module's one byte-protocol read: the
// archive streams raw under its own media type instead of decoded wire, so
// — like the Generation and update streams — its response is read directly;
// only the typed 410 cleaned-up envelope is decoded here, and the sanitized
// leaf filename and media type come from the response headers.
export async function downloadExactSource(
	conversationId: number,
): Promise<ChatSourceDownloadOutcome> {
	try {
		const response = await fetch(
			`${importSourceBase}/api/conversations/${conversationId}/import-source`,
		);
		if (response.ok) {
			const disposition = response.headers.get("content-disposition") ?? "";
			const match = /filename="([^"]+)"/.exec(disposition);
			const filename = match?.[1] ?? "imported-chat.jsonl";
			return {
				outcome: "available",
				filename,
				mediaType: response.headers.get("content-type") ?? "application/octet-stream",
				bytes: new Uint8Array(await response.arrayBuffer()),
			};
		}
		if (response.status === 404) return { outcome: "not-found" };
		if (response.status === 410) {
			const cleaned = decodeWirePayload(
				importCleanedUpResponse,
				await response.json().catch(() => null),
			);
			return cleaned === null
				? { outcome: "network" }
				: { outcome: "cleaned-up", reason: cleaned.reason };
		}
		return { outcome: "network" };
	} catch {
		return { outcome: "network" };
	}
}
