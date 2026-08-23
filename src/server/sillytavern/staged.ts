// User-facing staged Chat import: choose one file, stream its bytes into
// managed temporary staging storage exactly once, validate the complete
// source before any Participant resolution, and return a reviewable preview
// bound to the exact byte length and SHA-256 that were uploaded.
//
// This is the deep behavioral seam for the import flow: it composes only
// public capabilities (the SillyTavern adapter for validation, the
// Character Library for name-only suggestions, and the prior-import
// classifier for duplicate evidence). It creates no native Chat, no
// Participant, no Actor Profile, and no artifact metadata row; the previewed
// source stays in session-bound staging until a later commit ticket.
//
// Staging is session-bound by construction: the registry holding staged
// handles is a process-level in-memory map. A server restart naturally
// expires every staged flow and requires file reselection; no durable
// import draft or resume system is added. Discard (explicit cancellation)
// removes only the uncommitted temporary staging bytes of that one flow.

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { sha256Hex } from "../artifact";
import { createCharacterLibraryModule, type CharacterSummary } from "../character-library";
import { withDatabase } from "../database/database";
import {
	decodeSillyTavernSourceBytes,
	inspectSillyTavernChatJsonl,
	type SillyTavernChatInspection,
	type SillyTavernExactAuthor,
} from "./adapter";
import {
	StagedChatImportExpiredError,
	StagedChatImportTokenMismatchError,
	StagedChatImportUnavailableError,
	SillyTavernImportError,
} from "./errors";
import { chatNameFromFilename } from "./import";
import { findPriorImportsBySource } from "./prior-imports";

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
	// Explicit cancellation: removes the handle and deletes only that
	// flow's uncommitted staging bytes. Idempotent; unknown tokens are a
	// successful no-op.
	discard(token: string): void;
}

interface StagedRecord {
	token: string;
	originalFilename: string;
	byteLength: number;
	sha256: string;
	integrity: string | null;
	stagedPath: string;
	preview: ChatImportPreview;
}

// Session-bound staging registry. Process-level so every request-scoped
// module instance shares the same handles, and a server restart clears it
// wholesale (the expiry contract).
const stagedRegistry = new Map<string, StagedRecord>();

// Simulates the restart expiry for tests: drops every staged handle without
// touching the already staged files (a real restart runs no cleanup either;
// orphaned staging files are an accepted lifecycle tradeoff with no GC).
export const clearStagedImportRegistry = (): void => {
	stagedRegistry.clear();
};

// Streams the uploaded bytes into one staging file while hashing them in
// flight, so neither the HTTP boundary nor this module buffers the complete
// artifact in memory. The pump handles reader failures (for example an
// aborted upload) by discarding the partial staging file.
const streamToStagedFile = (
	path: string,
	bytes: ReadableStream<Uint8Array>,
): Promise<{ byteLength: number; sha256: string }> =>
	new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		let byteLength = 0;
		let settled = false;
		const output = createWriteStream(path, { flags: "wx" });
		const fail = (detail: Error) => {
			if (settled) return;
			settled = true;
			output.destroy();
			rmSync(path, { force: true });
			reject(detail);
		};
		output.on("error", fail);
		output.on("finish", () => {
			if (settled) return;
			settled = true;
			resolve({ byteLength, sha256: hash.digest("hex") });
		});
		const reader = bytes.getReader();
		const writeChunk = (chunk: Uint8Array): Promise<void> =>
			new Promise((resolveDrain, rejectDrain) => {
				if (output.write(chunk)) {
					resolveDrain();
					return;
				}
				output.once("drain", resolveDrain);
				output.once("error", rejectDrain);
			});
		const pump = async () => {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) {
						output.end();
						return;
					}
					hash.update(value);
					byteLength += value.byteLength;
					await writeChunk(value);
				}
			} catch (error) {
				// The reader or the staging writer failed mid-stream; parse the
				// boundary value once so the failure path only sees an Error.
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		};
		void pump();
	});

// Name-only matching: SillyTavern roles, header fields, avatar data,
// Message content, and `is_user` never influence a Character candidate.
const levenshtein = (a: string, b: string): number => {
	const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= b.length; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(
				current[j - 1]! + 1,
				previous[j]! + 1,
				previous[j - 1]! + cost,
			);
		}
		previous.splice(0, previous.length, ...current);
	}
	return previous[b.length]!;
};

const suggestionTier = (
	candidateName: string,
	key: string,
): SuggestionMatchKind | null => {
	if (candidateName === key) return "exact";
	if (candidateName.toLocaleLowerCase() === key.toLocaleLowerCase()) {
		return "case-insensitive";
	}
	// Fuzzy tier: a bounded normalized edit distance. Names too dissimilar
	// never cross into the suggestion set.
	const threshold = Math.max(
		1,
		Math.floor(Math.max(candidateName.length, key.length) * 0.25),
	);
	return levenshtein(candidateName, key) <= threshold ? "fuzzy" : null;
};

const tierRank = (tier: SuggestionMatchKind): number =>
	tier === "exact" ? 0 : tier === "case-insensitive" ? 1 : 2;

// Picks the strongest candidate by exact, then case-insensitive, then fuzzy
// tier. The library list is already library-ordered (pinned, then name,
// then id), so the first candidate of the winning tier is the strongest.
const strongestSuggestion = (
	key: string,
	characters: readonly CharacterSummary[],
): ChatImportSuggestion | null => {
	let best: { name: string; characterId: number; tier: SuggestionMatchKind } | null =
		null;
	for (const character of characters) {
		const tier = suggestionTier(character.name, key);
		if (tier === null) continue;
		if (best === null || tierRank(tier) < tierRank(best.tier)) {
			best = {
				name: character.name,
				characterId: character.id,
				tier,
			};
		}
	}
	return best === null
		? null
		: { characterId: best.characterId, name: best.name, match: best.tier, confirmed: false };
};

const isBlankAuthor = (key: string): boolean => key.trim() === "";

const buildGroups = (
	authors: readonly SillyTavernExactAuthor[],
	characters: readonly CharacterSummary[],
): ChatImportGroup[] => {
	const groups: {
		key: string;
		positions: number[];
		variantCount: number;
	}[] = [];
	const indexByKey = new Map<string, number>();
	for (const author of authors) {
		let index = indexByKey.get(author.name);
		if (index === undefined) {
			index = groups.length;
			indexByKey.set(author.name, index);
			groups.push({ key: author.name, positions: [], variantCount: 0 });
		}
		const group = groups[index];
		if (group === undefined) continue;
		group.positions.push(author.position);
		group.variantCount += author.variantCount;
	}
	return groups.map((group) => ({
		key: group.key,
		isBlank: isBlankAuthor(group.key),
		messagePositions: group.positions,
		messageCount: group.positions.length,
		variantCount: group.variantCount,
		participantNameDefault: isBlankAuthor(group.key)
			? UNKNOWN_IMPORTED_AUTHOR_NAME
			: group.key,
		suggestion: isBlankAuthor(group.key)
			? null
			: strongestSuggestion(group.key, characters),
	}));
};

const toDuplicateMatch = (match: { id: number; name: string }): ChatImportDuplicateMatch => ({
	id: match.id,
	name: match.name,
});

const buildPreview = (
	database: Database,
	originalFilename: string,
	byteLength: number,
	sha256: string,
	inspection: SillyTavernChatInspection,
): ChatImportPreview => {
	const characters = createCharacterLibraryModule(database).list();
	const matches = findPriorImportsBySource(database, inspection.report.source);
	return {
		title: chatNameFromFilename(originalFilename),
		originalFilename,
		sha256,
		byteLength,
		integrity: inspection.report.source.integrity ?? null,
		counts: { ...inspection.report.counts },
		warnings: [...inspection.report.warnings],
		groups: buildGroups(inspection.authors, characters),
		duplicates: {
			exact: matches.filter((match) => match.kind === "exact").map(toDuplicateMatch),
			related: matches.filter((match) => match.kind === "related").map(toDuplicateMatch),
		},
	};
};

const verifyStagedBytes = (
	record: StagedRecord,
): "available" | "missing" | "corrupt" => {
	let bytes: Buffer;
	try {
		bytes = readFileSync(record.stagedPath);
	} catch {
		return "missing";
	}
	return bytes.length === record.byteLength && sha256Hex(bytes) === record.sha256
		? "available"
		: "corrupt";
};

export function createChatImportModule(
	database: Database,
	options: ChatImportModuleOptions,
): ChatImportModule {
	const stagingRoot = join(options.artifactDirectory, "staging");
	mkdirSync(stagingRoot, { recursive: true });

	return {
		async stageFile({ bytes, originalFilename }) {
			const filename = basename(originalFilename);
			const stagedPath = join(stagingRoot, `${randomUUID()}.stage`);
			let staged: { byteLength: number; sha256: string };
			try {
				staged = await streamToStagedFile(stagedPath, bytes);
			} catch (error) {
				rmSync(stagedPath, { force: true });
				const detail = error instanceof Error ? error.message : String(error);
				throw new SillyTavernImportError(
					`Could not store the staged upload: ${detail}`,
				);
			}

			let inspection: SillyTavernChatInspection;
			try {
				const sourceText = decodeSillyTavernSourceBytes(
					readFileSync(stagedPath),
				);
				inspection = inspectSillyTavernChatJsonl(sourceText, {
					name: chatNameFromFilename(filename),
					filename,
					sha256: staged.sha256,
				});
			} catch (error) {
				// Validation failure discards the uploaded staging bytes so a
				// rejected file never lingers as an uncommitted temporary.
				rmSync(stagedPath, { force: true });
				throw error;
			}

			const preview = buildPreview(
				database,
				filename,
				staged.byteLength,
				staged.sha256,
				inspection,
			);
			const token = randomUUID();
			stagedRegistry.set(token, {
				token,
				originalFilename: filename,
				byteLength: staged.byteLength,
				sha256: staged.sha256,
				integrity: inspection.report.source.integrity ?? null,
				stagedPath,
				preview,
			});
			return { token, preview };
		},

		preview(token, expectedSha256) {
			const record = stagedRegistry.get(token);
			if (record === undefined) {
				throw new StagedChatImportExpiredError();
			}
			if (expectedSha256 !== undefined && expectedSha256 !== record.sha256) {
				throw new StagedChatImportTokenMismatchError();
			}
			const status = verifyStagedBytes(record);
			if (status !== "available") {
				throw new StagedChatImportUnavailableError(status);
			}
			return record.preview;
		},

		discard(token) {
			const record = stagedRegistry.get(token);
			if (record === undefined) return;
			stagedRegistry.delete(token);
			// Removes only this flow's uncommitted temporary staging bytes;
			// committed artifacts are never touched here.
			rmSync(record.stagedPath, { force: true });
		},
	};
}

// Runs one staged-import operation against a request-scoped module instance.
// Instances share the process-level staging registry, so handles survive
// across requests but never across a server restart.
export function withChatImport<T>(
	database: Database | undefined,
	artifactId: string,
	run: (chatImport: ChatImportModule) => T,
): T {
	return withDatabase(database, (connection) =>
		run(createChatImportModule(connection, { artifactDirectory: artifactId })),
	);
}