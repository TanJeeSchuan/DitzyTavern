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

// Payload types derive from the shared TypeBox contract so this client read
// model can never drift from the server's typed responses. The hand-rolled
// JSON guards further below stay deliberately: they are the transport seam
// that validates real wire payloads at this boundary.
import type {
	ChatHistoryAuthorStamp,
	ChatHistoryMessage,
	ChatHistoryPage,
	ChatHistoryVariant,
} from "../shared/contract/conversation-schema";
import type {
	ChatImportDetails,
	ChatImportDuplicateMatch,
	ImportDetailsArtifact,
	ImportDetailsArtifactAvailability,
} from "../shared/contract/chat-import";

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

import {
	type JsonValue,
	isBoolean,
	isNumber,
	isRow,
	isString,
	isStringArray,
} from "./lib/json-guards";

// Parses and validates one history page at the I/O boundary. Any field
// failing the typed contract discards the whole payload so a malformed
// response can never masquerade as trusted history.
const parseHistoryPage = (value: JsonValue): ChatHistoryPage | null => {
	if (!isRow(value) || !isNumber(value.conversationId)) return null;
	if (!isString(value.name) || !isNumber(value.revision)) return null;
	const page = value.page;
	if (
		!isRow(page) ||
		!isNumber(page.index) ||
		!isNumber(page.pageSize) ||
		!isNumber(page.totalMessages) ||
		!isNumber(page.totalPages) ||
		!isBoolean(page.hasOlder) ||
		!isBoolean(page.hasNewer)
	) {
		return null;
	}
	if (!Array.isArray(value.cast)) return null;
	const cast: ChatHistoryPage["cast"] = [];
	for (const raw of value.cast) {
		if (!isRow(raw) || !isNumber(raw.id) || !isNumber(raw.position) || !isString(raw.name)) {
			return null;
		}
		cast.push({ id: raw.id, position: raw.position, name: raw.name });
	}
	if (!Array.isArray(value.messages)) return null;
	const messages: ChatHistoryMessage[] = [];
	for (const rawMessage of value.messages) {
		if (!isRow(rawMessage) || !isNumber(rawMessage.id)) return null;
		if (!isNumber(rawMessage.position) || !isString(rawMessage.timestamp)) return null;
		let author: ChatHistoryAuthorStamp | null = null;
		const rawAuthor = rawMessage.author;
		if (rawAuthor !== null) {
			if (
				!isRow(rawAuthor) ||
				!isBoolean(rawAuthor.inCast) ||
				(rawAuthor.participantId !== null && !isNumber(rawAuthor.participantId)) ||
				(rawAuthor.capturedName !== null && !isString(rawAuthor.capturedName))
			) {
				return null;
			}
			author = {
				participantId: rawAuthor.participantId,
				capturedName: rawAuthor.capturedName,
				inCast: rawAuthor.inCast,
			};
		}
		const rawModelParticipantId = rawMessage.modelParticipantIdAtCreation;
		if (
			rawModelParticipantId !== undefined &&
			rawModelParticipantId !== null &&
			!isNumber(rawModelParticipantId)
		) {
			return null;
		}
		const rawContinuable = rawMessage.continuable;
		if (rawContinuable !== undefined && !isBoolean(rawContinuable)) return null;
		if (!Array.isArray(rawMessage.variants)) return null;
		const variants: ChatHistoryVariant[] = [];
		for (const rawVariant of rawMessage.variants) {
			if (
				!isRow(rawVariant) ||
				!isNumber(rawVariant.id) ||
				!isNumber(rawVariant.position) ||
				!isString(rawVariant.content) ||
				!isString(rawVariant.timestamp) ||
				!isBoolean(rawVariant.selected)
			) {
				return null;
			}
			variants.push({
				id: rawVariant.id,
				position: rawVariant.position,
				content: rawVariant.content,
				timestamp: rawVariant.timestamp,
				selected: rawVariant.selected,
			});
		}
		messages.push({
			id: rawMessage.id,
			position: rawMessage.position,
			timestamp: rawMessage.timestamp,
			modelParticipantIdAtCreation: rawModelParticipantId,
			continuable: rawContinuable,
			author,
			variants,
		});
	}
	return {
		conversationId: value.conversationId,
		name: value.name,
		revision: value.revision,
		cast,
		page: {
			index: page.index,
			pageSize: page.pageSize,
			totalMessages: page.totalMessages,
			totalPages: page.totalPages,
			hasOlder: page.hasOlder,
			hasNewer: page.hasNewer,
		},
		messages,
	};
};

const parseImportDetails = (value: JsonValue): ChatImportDetails | null => {
	if (!isRow(value) || !isNumber(value.conversationId) || !isString(value.title)) {
		return null;
	}
	const receipt = value.receipt;
	const counts = isRow(receipt) ? receipt.counts : null;
	if (
		!isRow(receipt) ||
		!isString(receipt.originalFilename) ||
		!isString(receipt.sha256) ||
		(receipt.byteLength !== null && !isNumber(receipt.byteLength)) ||
		(receipt.integrity !== null && !isString(receipt.integrity)) ||
		!isRow(counts) ||
		!isNumber(counts.messages) ||
		!isNumber(counts.variants) ||
		!isStringArray(receipt.warnings) ||
		!isString(receipt.importerVersion)
	) {
		return null;
	}

	const duplicates = value.duplicates;
	const matchList = (entries: JsonValue): ChatImportDuplicateMatch[] | null => {
		if (!Array.isArray(entries)) return null;
		const matches: ChatImportDuplicateMatch[] = [];
		for (const entry of entries) {
			if (!isRow(entry) || !isNumber(entry.id) || !isString(entry.name)) return null;
			matches.push({ id: entry.id, name: entry.name });
		}
		return matches;
	};
	if (!isRow(duplicates)) return null;
	const exact = matchList(duplicates.exact);
	const related = matchList(duplicates.related);
	if (exact === null || related === null) return null;

	let artifact: ImportDetailsArtifact | null = null;
	const rawArtifact = value.artifact;
	if (rawArtifact !== null) {
		if (
			!isRow(rawArtifact) ||
			!isNumber(rawArtifact.chatId) ||
			!isString(rawArtifact.namespace) ||
			!isString(rawArtifact.key) ||
			!isString(rawArtifact.relativePath) ||
			!isString(rawArtifact.originalFilename) ||
			!isString(rawArtifact.mediaType) ||
			!isNumber(rawArtifact.byteLength) ||
			!isString(rawArtifact.sha256)
		) {
			return null;
		}
		const availability = rawArtifact.availability;
		let parsedAvailability: ImportDetailsArtifactAvailability;
		if (isRow(availability) && availability.status === "available") {
			parsedAvailability = { status: "available" };
		} else if (
			isRow(availability) &&
			availability.status === "cleaned-up" &&
			(availability.reason === "missing" || availability.reason === "corrupt")
		) {
			parsedAvailability = { status: "cleaned-up", reason: availability.reason };
		} else {
			return null;
		}
		artifact = {
			chatId: rawArtifact.chatId,
			namespace: rawArtifact.namespace,
			key: rawArtifact.key,
			relativePath: rawArtifact.relativePath,
			originalFilename: rawArtifact.originalFilename,
			mediaType: rawArtifact.mediaType,
			byteLength: rawArtifact.byteLength,
			sha256: rawArtifact.sha256,
			availability: parsedAvailability,
		};
	}

	return {
		conversationId: value.conversationId,
		title: value.title,
		receipt: {
			originalFilename: receipt.originalFilename,
			sha256: receipt.sha256,
			byteLength: receipt.byteLength === null ? null : receipt.byteLength,
			integrity: receipt.integrity === null ? null : receipt.integrity,
			counts: { messages: counts.messages, variants: counts.variants },
			warnings: receipt.warnings,
			importerVersion: receipt.importerVersion,
		},
		duplicates: { exact, related },
		artifact,
	};
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
		if (isRow(value) && value.outcome === "cleaned-up") {
			return {
				status: "cleaned-up",
				reason: value.reason === "corrupt" ? "corrupt" : "missing",
			};
		}
		return { status: "cleaned-up", reason: "missing" };
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
