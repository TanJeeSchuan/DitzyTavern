// Replaceable typed client for the staged Chat import transport adapters.
// Every view uses this single boundary: upload streams the selected bytes
// once (never a browser filesystem path), preview re-reads the bound
// preview from the token the client already holds, and discard cancels the
// flow. Outcomes mirror the server's typed results so the view can recover
// from recoverable errors without re-uploading or losing its drafts.

export type SuggestionMatchKind = "exact" | "case-insensitive" | "fuzzy";

export interface ChatImportSuggestion {
	characterId: number;
	name: string;
	match: SuggestionMatchKind;
	// The strongest suggestion is always pre-filled but unconfirmed; final
	// review cannot pass until the user approves it.
	confirmed: boolean;
}

export interface ChatImportGroup {
	// The verbatim captured author string; the empty string for blank names.
	key: string;
	isBlank: boolean;
	messagePositions: number[];
	messageCount: number;
	variantCount: number;
	// Proposed native Participant name, editable by the user.
	participantNameDefault: string;
	suggestion: ChatImportSuggestion | null;
}

export interface ChatImportDuplicateMatch {
	id: number;
	name: string;
}

export interface ChatImportPreview {
	title: string;
	originalFilename: string;
	sha256: string;
	byteLength: number;
	integrity: string | null;
	counts: { messages: number; variants: number };
	warnings: string[];
	groups: ChatImportGroup[];
	duplicates: {
		exact: ChatImportDuplicateMatch[];
		related: ChatImportDuplicateMatch[];
	};
}

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

export interface ChatImportTransport {
	// Uploads the selected bytes exactly once and receives the staged token
	// bound to the preview. `bytes` is the File/Blob the user chose; only
	// its leaf `originalFilename` travels alongside.
	stage(bytes: Blob, originalFilename: string): Promise<ChatImportStageOutcome>;
	// Re-reads the bound preview for a recoverable transport error. The
	// client supplies the token and the SHA-256 it already knows, so a
	// preview can never be fetched against a different hash.
	preview(token: string, sha256: string): Promise<ChatImportPreviewOutcome>;
	// Cancels the flow; only that flow's uncommitted staging data is
	// removed. Idempotent.
	discard(token: string): Promise<void>;
}

// JSON shape parsed at the fetch boundary; response.json() can only resolve
// to the JSON scalars, arrays, and plain objects modeled here.
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonRow = { [key: string]: JsonValue };

const isRow = (value: JsonValue): value is JsonRow =>
	value !== null &&
	value !== undefined &&
	!Array.isArray(value) &&
	value.constructor === Object;

const isString = (value: JsonValue): value is string =>
	value !== null && value !== undefined && value.constructor === String;

const isNumber = (value: JsonValue): value is number =>
	value !== null && value !== undefined && value.constructor === Number;

const isBoolean = (value: JsonValue): value is boolean =>
	value !== null && value !== undefined && value.constructor === Boolean;

const isStringArray = (value: JsonValue): value is string[] =>
	Array.isArray(value) && value.every(isString);

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
		if (
			!Array.isArray(positions) ||
			!positions.every(isNumber) ||
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