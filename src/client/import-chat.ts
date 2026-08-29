// Replaceable typed client for the staged Chat import transport adapters.
// Every view uses this single boundary: upload streams the selected bytes
// once (never a browser filesystem path), preview re-reads the bound
// preview from the token the client already holds, and discard cancels the
// flow. Outcomes mirror the server's typed results so the view can recover
// from recoverable errors without re-uploading or losing its drafts.

// Payload types derive from the shared TypeBox contract so this client
// boundary can never drift from the server's typed responses. The
// hand-rolled JSON guards further below stay deliberately: they are the
// transport seam that validates real wire payloads at this boundary.
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

// The match kinds are the contract's closed literal union on the suggestion.
export type SuggestionMatchKind = ChatImportSuggestion["match"];

export type ChatImportStageOutcome =
	| { status: "staged"; token: string; preview: ChatImportPreview }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export type ChatImportPreviewOutcome =
	| { status: "available"; preview: ChatImportPreview }
	// The flow expired (server restart or prior cancellation): reselect.
	| { status: "expired" }
	| { status: "unavailable"; reason: "missing" | "corrupt" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

// The commit payload is the contract's commit body minus the SHA-256 the
// transport itself already binds into every request.
export type ChatImportCommitInput = Omit<ChatImportCommitBody, "sha256">;

// The receipt's outcome labels are the contract's closed literal union.
export type ChatImportResolvedOutcome = ChatImportReceiptParticipant["outcome"];

export type ChatImportCommitOutcome =
	| { status: "committed"; conversationId: number; receipt: ChatImportReceipt }
	// The flow expired or the staged bytes are gone/corrupt: reselect.
	| { status: "expired" }
	| { status: "unavailable"; reason: "missing" | "corrupt" }
	| { status: "invalid"; reason: string }
	| { status: "network" };

export interface ChatImportTransport {
	// Uploads the selected bytes exactly once and receives the staged token
	// bound to the preview. `bytes` is the File/Blob the user chose; only
	// its leaf `originalFilename` travels alongside.
	stage(bytes: Blob, originalFilename: string): Promise<ChatImportStageOutcome>;
	// Re-reads the bound preview for a recoverable transport error. The
	// client supplies the token and the SHA-256 it already knows, so a
	// preview can never be fetched against a different hash.
	preview(token: string, sha256: string): Promise<ChatImportPreviewOutcome>;
	// Commits the confirmed resolution plan against the exact staged bytes.
	// The token and SHA-256 the client already knows bind the request to
	// the previewed source; a lost response can be retried with the same
	// payload and returns the same committed result.
	commit(
		token: string,
		sha256: string,
		input: ChatImportCommitInput,
	): Promise<ChatImportCommitOutcome>;
	// Cancels the flow; only that flow's uncommitted staging data is
	// removed. Idempotent.
	discard(token: string): Promise<void>;
}

import {
	type JsonValue,
	isBoolean,
	isNumber,
	isRow,
	isString,
	isStringArray,
} from "./lib/json-guards";

// Parses and validates one preview payload at the I/O boundary. Any field
// failing the typed contract discards the whole payload so a malformed
// response can never masquerade as a trusted preview.
const parsePreview = (value: JsonValue): ChatImportPreview | null => {
	if (!isRow(value)) return null;
	const counts = value.counts;
	if (!isRow(counts) || !isNumber(counts.messages) || !isNumber(counts.variants)) {
		return null;
	}
	const duplicates = value.duplicates;
	if (!isRow(duplicates)) return null;
	const matchList = (entries: JsonValue): ChatImportDuplicateMatch[] | null => {
		if (!Array.isArray(entries)) return null;
		const matches: ChatImportDuplicateMatch[] = [];
		for (const entry of entries) {
			if (!isRow(entry) || !isNumber(entry.id) || !isString(entry.name)) return null;
			matches.push({ id: entry.id, name: entry.name });
		}
		return matches;
	};
	const exact = matchList(duplicates.exact);
	const related = matchList(duplicates.related);
	if (exact === null || related === null) return null;

	const groups: ChatImportGroup[] = [];
	const rawGroups = value.groups;
	if (!Array.isArray(rawGroups)) return null;
	for (const rawGroup of rawGroups) {
		if (!isRow(rawGroup) || !isString(rawGroup.key)) return null;
		const positions = rawGroup.messagePositions;
		const variantCounts = rawGroup.messageVariantCounts;
		if (
			!Array.isArray(positions) ||
			!positions.every(isNumber) ||
			!Array.isArray(variantCounts) ||
			!variantCounts.every(isNumber) ||
			variantCounts.length !== positions.length ||
			!isBoolean(rawGroup.isBlank) ||
			!isNumber(rawGroup.messageCount) ||
			!isNumber(rawGroup.variantCount) ||
			!isString(rawGroup.participantNameDefault)
		) {
			return null;
		}
		let suggestion: ChatImportSuggestion | null = null;
		const rawSuggestion = rawGroup.suggestion;
		if (rawSuggestion !== null) {
			if (!isRow(rawSuggestion) || !isNumber(rawSuggestion.characterId)) return null;
			const match = rawSuggestion.match;
			if (
				match !== "exact" &&
				match !== "case-insensitive" &&
				match !== "fuzzy"
			) {
				return null;
			}
			if (!isString(rawSuggestion.name) || !isBoolean(rawSuggestion.confirmed)) {
				return null;
			}
			suggestion = {
				characterId: rawSuggestion.characterId,
				name: rawSuggestion.name,
				match,
				confirmed: rawSuggestion.confirmed,
			};
		}
		groups.push({
			key: rawGroup.key,
			isBlank: rawGroup.isBlank,
			messagePositions: positions.map((position) => position),
			messageVariantCounts: variantCounts.map((count) => count),
			messageCount: rawGroup.messageCount,
			variantCount: rawGroup.variantCount,
			participantNameDefault: rawGroup.participantNameDefault,
			suggestion,
		});
	}

	if (
		!isString(value.title) ||
		!isString(value.originalFilename) ||
		!isString(value.sha256) ||
		!isNumber(value.byteLength) ||
		(value.integrity !== null && !isString(value.integrity)) ||
		!isStringArray(value.warnings)
	) {
		return null;
	}
	return {
		title: value.title,
		originalFilename: value.originalFilename,
		sha256: value.sha256,
		byteLength: value.byteLength,
		integrity: value.integrity === null ? null : value.integrity,
		counts: { messages: counts.messages, variants: counts.variants },
		warnings: value.warnings,
		groups,
		duplicates: { exact, related },
	};
};

const parseStageResponse = async (
	response: Response,
): Promise<ChatImportStageOutcome> => {
	const value: JsonValue = await response.json().catch(() => ({}));
	if (!isRow(value)) return { status: "network" };
	if (!response.ok) {
		if (value.outcome === "invalid" && isString(value.reason)) {
			return { status: "invalid", reason: value.reason };
		}
		return { status: "network" };
	}
	if (value.outcome !== "staged" || !isString(value.token)) {
		return { status: "network" };
	}
	const preview = parsePreview(value.preview);
	if (preview === null) return { status: "network" };
	return { status: "staged", token: value.token, preview };
};

const parsePreviewResponse = async (
	response: Response,
): Promise<ChatImportPreviewOutcome> => {
	const value: JsonValue = await response.json().catch(() => ({}));
	if (!isRow(value)) return { status: "network" };
	if (response.status === 410) {
		if (value.outcome === "unavailable") {
			return {
				status: "unavailable",
				reason: value.reason === "corrupt" ? "corrupt" : "missing",
			};
		}
		return { status: "expired" };
	}
	if (!response.ok) {
		if (value.outcome === "invalid" && isString(value.reason)) {
			return { status: "invalid", reason: value.reason };
		}
		return { status: "network" };
	}
	if (value.outcome !== "available") {
		return { status: "network" };
	}
	const preview = parsePreview(value.preview);
	if (preview === null) return { status: "network" };
	return { status: "available", preview };
};

// Parses and validates one receipt payload at the I/O boundary, mirroring
// the server's typed receipt so a malformed response can never masquerade
// as a committed import.
const parseReceipt = (value: JsonValue): ChatImportReceipt | null => {
	if (!isRow(value)) return null;
	const counts = value.counts;
	if (!isRow(counts) || !isNumber(counts.messages) || !isNumber(counts.variants)) {
		return null;
	}
	const duplicates = value.duplicates;
	if (!isRow(duplicates)) return null;
	const matchList = (entries: JsonValue): ChatImportDuplicateMatch[] | null => {
		if (!Array.isArray(entries)) return null;
		const matches: ChatImportDuplicateMatch[] = [];
		for (const entry of entries) {
			if (!isRow(entry) || !isNumber(entry.id) || !isString(entry.name)) return null;
			matches.push({ id: entry.id, name: entry.name });
		}
		return matches;
	};
	const exact = matchList(duplicates.exact);
	const related = matchList(duplicates.related);
	if (exact === null || related === null) return null;

	const participants: ChatImportReceiptParticipant[] = [];
	const rawParticipants = value.participants;
	if (!Array.isArray(rawParticipants)) return null;
	for (const rawParticipant of rawParticipants) {
		if (!isRow(rawParticipant) || !isString(rawParticipant.name)) return null;
		const outcome = rawParticipant.outcome;
		if (
			outcome !== "fork" &&
			outcome !== "new-character" &&
			outcome !== "chat-only"
		) {
			return null;
		}
		if (
			rawParticipant.sourceCharacterId !== null &&
			!isNumber(rawParticipant.sourceCharacterId)
		) {
			return null;
		}
		participants.push({
			name: rawParticipant.name,
			outcome,
			sourceCharacterId:
				rawParticipant.sourceCharacterId === null
					? null
					: rawParticipant.sourceCharacterId,
		});
	}

	if (
		!isNumber(value.conversationId) ||
		!isString(value.title) ||
		!isString(value.originalFilename) ||
		!isString(value.sha256) ||
		!isNumber(value.byteLength) ||
		!isStringArray(value.warnings)
	) {
		return null;
	}
	return {
		conversationId: value.conversationId,
		title: value.title,
		originalFilename: value.originalFilename,
		sha256: value.sha256,
		byteLength: value.byteLength,
		counts: { messages: counts.messages, variants: counts.variants },
		participants,
		warnings: value.warnings,
		duplicates: { exact, related },
	};
};

const parseCommitResponse = async (
	response: Response,
): Promise<ChatImportCommitOutcome> => {
	const value: JsonValue = await response.json().catch(() => ({}));
	if (!isRow(value)) return { status: "network" };
	if (response.status === 410) {
		if (value.outcome === "unavailable") {
			return {
				status: "unavailable",
				reason: value.reason === "corrupt" ? "corrupt" : "missing",
			};
		}
		return { status: "expired" };
	}
	if (!response.ok) {
		if (value.outcome === "invalid" && isString(value.reason)) {
			return { status: "invalid", reason: value.reason };
		}
		return { status: "network" };
	}
	if (value.outcome !== "committed") {
		return { status: "network" };
	}
	const receipt = parseReceipt(value.receipt);
	if (receipt === null) return { status: "network" };
	return { status: "committed", conversationId: receipt.conversationId, receipt };
};

export interface ChatImportTransportOptions {
	// Server origin; defaults to the current page origin in the browser.
	base?: string;
	// Injectable request function for tests (for example one backed by
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
				// Cancellation is best-effort: a lost discard leaves only an
				// uncommitted temporary staging file behind.
			}
		},
	};
};

// Cancels a staged flow when a handle exists. Null handles and lost discard
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

// The default boundary used by the Import Chat UI.
export const chatImportTransport: ChatImportTransport =
	createChatImportTransport();