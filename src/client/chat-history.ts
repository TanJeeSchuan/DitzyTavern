// Replaceable typed client boundary for reading a Chat's native history and
// its Import Details. Every view uses this single boundary: pagination,
// receipt loading, heavy provenance, and artifact download stay behind typed
// operations instead of embedding transport behavior throughout Message
// components.
//
// The paginated read model is the normal Chat read: stable chronological
// pages of native Messages with Participant identity, immutable Author
// Stamp names, Variant order, and selected Variant state. Exact artifact
// bytes, the canonical archive text, reasoning, and signatures never cross
// this boundary; they load only through the deliberate Import Details
// operations below.

// Payload types and wire validation both derive from the shared TypeBox
// contract: every response is decoded at this boundary with Value.Decode so
// a malformed payload can never masquerade as trusted history.
import { Value } from "@sinclair/typebox/value";
import type {
	ChatHistoryAuthorStamp,
	ChatHistoryMessage,
	ChatHistoryPage,
	ChatHistoryVariant,
} from "../shared/contract/conversation-schema";
import { chatHistoryPage } from "../shared/contract/conversation-schema";
import type {
	ChatImportDetails,
	ChatImportDuplicateMatch,
	ImportDetailsArtifact,
	ImportDetailsArtifactAvailability,
} from "../shared/contract/chat-import";
import {
	chatImportDetails,
	importCleanedUpResponse,
} from "../shared/contract/chat-import";
import type { JsonValue } from "./lib/json-guards";

export type {
	ChatHistoryAuthorStamp,
	ChatHistoryMessage,
	ChatHistoryPage,
	ChatHistoryVariant,
};
export type {
	ChatImportDetails,
	ChatImportDuplicateMatch,
	ImportDetailsArtifact,
	ImportDetailsArtifactAvailability,
};

export interface ChatHistoryPageRequest {
	// 1-based page within the stable position-ordered chronology, counted
	// backward from the newest Message (page 1 = latest window).
	page?: number;
	pageSize?: number;
}

export type ChatHistoryOutcome =
	| { status: "available"; page: ChatHistoryPage }
	| { status: "not-found" }
	| { status: "network" };

export type ChatImportDetailsOutcome =
	| { status: "available"; details: ChatImportDetails }
	// The Chat is missing or carries no import provenance; the view treats
	// both as "no Import Details" without any persistent import marker.
	| { status: "not-found" }
	| { status: "network" };

// Exact-source download outcome. Missing or corrupt exact artifacts are a
// typed cleaned-up result: only exact download is affected, never normal
// Chat reading or commands.
export type ChatSourceDownloadOutcome =
	| { status: "available"; filename: string; mediaType: string; bytes: Uint8Array }
	| { status: "cleaned-up"; reason: "missing" | "corrupt" }
	| { status: "not-found" }
	| { status: "network" };

export interface ChatHistoryTransport {
	// Reads one stable chronological page of native Messages.
	loadHistory(
		conversationId: number,
		request?: ChatHistoryPageRequest,
	): Promise<ChatHistoryOutcome>;
	// Loads the persisted receipt and source identity for one Chat; a typed
	// not-found for Chats without import provenance.
	loadImportDetails(conversationId: number): Promise<ChatImportDetailsOutcome>;
	// Downloads the exact managed source bytes with the stored original leaf
	// filename. Cleaned-up is a typed outcome, never an exception.
	downloadExactSource(conversationId: number): Promise<ChatSourceDownloadOutcome>;
}

// Validates and decodes one history page against the canonical shared
// contract at the I/O boundary. Any field failing the typed contract
// discards the whole payload so a malformed response can never masquerade
// as trusted history.
const parseHistoryPage = (value: JsonValue): ChatHistoryPage | null => {
	try {
		return Value.Decode(chatHistoryPage, value);
	} catch {
		return null;
	}
};

const parseImportDetails = (value: JsonValue): ChatImportDetails | null => {
	try {
		return Value.Decode(chatImportDetails, value);
	} catch {
		return null;
	}
};

const parseHistoryResponse = async (
	response: Response,
): Promise<ChatHistoryOutcome> => {
	if (response.status === 404) return { status: "not-found" };
	if (!response.ok) return { status: "network" };
	const value: JsonValue = await response.json().catch(() => ({}));
	const page = parseHistoryPage(value);
	if (page === null) return { status: "network" };
	return { status: "available", page };
};

const parseImportDetailsResponse = async (
	response: Response,
): Promise<ChatImportDetailsOutcome> => {
	if (response.status === 404) return { status: "not-found" };
	if (!response.ok) return { status: "network" };
	const value: JsonValue = await response.json().catch(() => ({}));
	const details = parseImportDetails(value);
	if (details === null) return { status: "network" };
	return { status: "available", details };
};

const parseDownloadResponse = async (
	response: Response,
): Promise<ChatSourceDownloadOutcome> => {
	if (response.status === 404) return { status: "not-found" };
	if (response.status === 410) {
		const value: JsonValue = await response.json().catch(() => ({}));
		try {
			const cleaned = Value.Decode(importCleanedUpResponse, value);
			return {
				status: "cleaned-up",
				reason: cleaned.reason,
			};
		} catch {
			return { status: "cleaned-up", reason: "missing" };
		}
	}
	if (!response.ok) return { status: "network" };
	const disposition = response.headers.get("content-disposition") ?? "";
	const match = /filename="([^"]+)"/.exec(disposition);
	const filename = match?.[1] ?? "imported-chat.jsonl";
	return {
		status: "available",
		filename,
		mediaType: response.headers.get("content-type") ?? "application/octet-stream",
		bytes: new Uint8Array(await response.arrayBuffer()),
	};
};

export interface ChatHistoryTransportOptions {
	// Server origin; defaults to the current page origin in the browser.
	base?: string;
	// Injectable request function for tests (for example one backed by
	// a mocked Response).
	fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
	// Whether downloads should run in the current environment. Tests pass a
	// fetchImpl and never trigger browser navigation.
	supportsDownload?: boolean;
}

export const createChatHistoryTransport = (
	options: ChatHistoryTransportOptions = {},
): ChatHistoryTransport => {
	const base =
		options.base ??
		(globalThis.window === undefined
			? "http://localhost"
			: window.location.origin);
	const request = options.fetchImpl ?? ((input, init) => fetch(input, init));

	const historyUrl = (conversationId: number, page?: ChatHistoryPageRequest) => {
		const query = new URLSearchParams();
		if (page?.page !== undefined) query.set("page", String(page.page));
		if (page?.pageSize !== undefined) query.set("pageSize", String(page.pageSize));
		const suffix = query.size > 0 ? `?${query.toString()}` : "";
		return `${base}/api/conversations/${conversationId}/history${suffix}`;
	};

	return {
		async loadHistory(conversationId, page) {
			try {
				const response = await request(historyUrl(conversationId, page));
				return await parseHistoryResponse(response);
			} catch {
				return { status: "network" };
			}
		},
		async loadImportDetails(conversationId) {
			try {
				const response = await request(
					`${base}/api/conversations/${conversationId}/import-details`,
				);
				return await parseImportDetailsResponse(response);
			} catch {
				return { status: "network" };
			}
		},
		async downloadExactSource(conversationId) {
			try {
				const response = await request(
					`${base}/api/conversations/${conversationId}/import-source`,
				);
				return await parseDownloadResponse(response);
			} catch {
				return { status: "network" };
			}
		},
	};
};

// The default boundary used by the Chat reading UI.
export const chatHistoryTransport: ChatHistoryTransport =
	createChatHistoryTransport();

// Triggers a browser download of the exact managed bytes using the stored
// original leaf filename. Returns whether the download started; cleaned-up
// artifacts never reach this point (the view disables the action).
export const downloadImportedSourceInBrowser = (
	filename: string,
	mediaType: string,
	bytes: Uint8Array,
	callback: (href: string, download: string) => void = (href, download) => {
		const anchor = document.createElement("a");
		anchor.href = href;
		anchor.download = download;
		document.body.appendChild(anchor);
		anchor.click();
		anchor.remove();
	},
): void => {
	const objectUrl = URL.createObjectURL(
		new Blob([new Uint8Array(bytes)], { type: mediaType }),
	);
	try {
		callback(objectUrl, filename);
	} finally {
		window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
	}
};
