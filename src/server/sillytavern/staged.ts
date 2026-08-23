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
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import type { Database } from "bun:sqlite";
import { mediaTypeFromFilename, sha256Hex, uniqueManagedRelativePath } from "../artifact";
import { createCharacterLibraryModule, type CharacterSummary } from "../character-library";
import { createConversationModule } from "../conversation";
import type {
	ConversationSnapshot,
	ConversationParticipantSeed,
	ParticipantDefinition,
} from "../conversation/types";
import { withDatabase } from "../database/database";
import {
	EXACT_SOURCE_ARTIFACT_KEY,
	EXACT_SOURCE_ARTIFACT_NAMESPACE,
	decodeSillyTavernImportSource,
	decodeSillyTavernSourceBytes,
	deterministicImportControl,
	emptyImportedPrompt,
	importReportEntries,
	inspectSillyTavernChatJsonl,
	type SillyTavernChatInspection,
	type SillyTavernExactAuthor,
} from "./adapter";
import {
	StagedChatImportDuplicateConfirmationError,
	StagedChatImportExpiredError,
	StagedChatImportPlanError,
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
	// Variant count of each retained Message, parallel to messagePositions,
	// so the resolver can present per-Message inspection and selection.
	messageVariantCounts: number[];
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

// The three resolution outcomes a resulting Participant may take: fork an
// existing Actor Profile into an independent Conversation-local Participant,
// create a Participant together with a minimal new Actor Profile, or keep a
// complete Chat-only Participant. No skip, source-role inference, or later
// re-assignment alternative exists.
export type ImportResolutionOutcome =
	| { type: "fork"; characterId: number }
	| { type: "new-character" }
	| { type: "chat-only" };

// One resulting Participant in the user-confirmed resolution plan. Whole
// Messages are referenced by their 1-based record positions; every retained
// Message must belong to exactly one Participant and none may be skipped.
// The source author strings themselves are never part of the plan: preserved
// import data keeps the exact captured values regardless of grouping.
export interface ChatImportResolvedParticipantPlan {
	// Proposed native Participant name. For a fork the server derives the
	// authoritative name from the selected Profile's current name instead.
	name: string;
	outcome: ImportResolutionOutcome;
	messagePositions: number[];
}

export interface ChatImportCommitInput {
	// The SHA-256 the client already knows from the preview; only the exact
	// staged bytes that produced the preview may be committed.
	sha256: string;
	// The editable Chat title confirmed at final review.
	title: string;
	// Explicit import another copy confirmation, required only when the
	// staged source is an exact duplicate of a prior import.
	duplicateConfirmed: boolean;
	participants: ChatImportResolvedParticipantPlan[];
}

export type ChatImportResolvedOutcome = "fork" | "new-character" | "chat-only";

export interface ChatImportReceiptParticipant {
	name: string;
	outcome: ChatImportResolvedOutcome;
	sourceCharacterId: number | null;
}

// Compact post-commit receipt: what was created, under which source
// identity, with which Participants and outcomes. Receipt details also
// persist as Conversation-scoped report data; the receipt itself is the
// immediate success surface, never a badge, category, or capability flag.
export interface ChatImportReceipt {
	conversationId: number;
	title: string;
	originalFilename: string;
	sha256: string;
	byteLength: number;
	counts: { messages: number; variants: number };
	participants: ChatImportReceiptParticipant[];
	warnings: string[];
	duplicates: {
		exact: ChatImportDuplicateMatch[];
		related: ChatImportDuplicateMatch[];
	};
}

export interface ChatImportCommitResult {
	conversation: ConversationSnapshot;
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
	// Commits the user-confirmed resolution plan for one staged handle. Only
	// the exact staged bytes that produced the preview are committed; the
	// managed exact artifact is finalized before the database operation, and
	// the Chat, requested new Profiles, Participants, Roster membership,
	// Author Stamps, Messages, Variants, canonical archive, report, and
	// artifact metadata commit as one all-or-nothing SQLite operation through
	// public domain seams. A token succeeds at most once: retrying after a
	// lost response returns the original successful result instead of
	// creating another Chat. Recoverable plan failures preserve the staged
	// preview and resolution choices; failures after the artifact is
	// finalized are non-recoverable and the flow must reselect the file.
	commit(token: string, input: ChatImportCommitInput): ChatImportCommitResult;
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
// wholesale (the expiry contract). Committed results are kept under their
// consumed token so a retry after a lost response returns the original
// successful result rather than creating another Chat.
const stagedRegistry = new Map<string, StagedRecord>();
const committedResults = new Map<string, ChatImportCommitResult>();

// Simulates the restart expiry for tests: drops every staged handle and
// every retained committed result without touching the already staged or
// committed files (a real restart runs no cleanup either; orphaned files are
// an accepted lifecycle tradeoff with no GC).
export const clearStagedImportRegistry = (): void => {
	stagedRegistry.clear();
	committedResults.clear();
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
		variantCounts: number[];
	}[] = [];
	const indexByKey = new Map<string, number>();
	for (const author of authors) {
		let index = indexByKey.get(author.name);
		if (index === undefined) {
			index = groups.length;
			indexByKey.set(author.name, index);
			groups.push({ key: author.name, positions: [], variantCounts: [] });
		}
		const group = groups[index];
		if (group === undefined) continue;
		group.positions.push(author.position);
		group.variantCounts.push(author.variantCount);
	}
	return groups.map((group) => ({
		key: group.key,
		isBlank: isBlankAuthor(group.key),
		messagePositions: group.positions,
		messageVariantCounts: group.variantCounts,
		messageCount: group.positions.length,
		variantCount: group.variantCounts.reduce((total, count) => total + count, 0),
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

// ---- Commit machinery ----

interface ResolvedPlanParticipant {
	plan: ChatImportResolvedParticipantPlan;
	definition: ParticipantDefinition;
	sourceCharacterId: number | null;
	// True when the resolution creates a new Actor Profile in the same
	// database operation as the Chat; the created Profile becomes the
	// Participant's immutable provenance source, exactly like a fork.
	createProfile: boolean;
}

// Structural validation of the user-confirmed plan. Runs entirely before
// the exact artifact is finalized, so every rejection here is recoverable:
// the staged preview, the staged bytes, and every resolution choice stay
// intact for correction. The resolver never offers Message skipping, so the
// plan must assign every retained Message to exactly one Participant.
//
// Trust boundary: the client owns the confirmation UX (blank captured names
// must be explicitly confirmed or edited, and every fork Character must be
// explicitly approved). The authoritative server invariant is that every
// resulting Participant name is nonblank; the confirmation flags themselves
// live in the client resolver and are not part of the wire contract.
const validateResolutionPlan = (
	record: StagedRecord,
	messageCount: number,
	input: ChatImportCommitInput,
): void => {
	if (input.title.trim() === "") {
		throw new StagedChatImportPlanError("A nonblank Chat title is required.");
	}
	if (input.participants.length === 0) {
		if (messageCount === 0) return;
		throw new StagedChatImportPlanError(
			`Every Message must belong to a Participant; ${messageCount} Message${messageCount === 1 ? "" : "s"} ${messageCount === 1 ? "is" : "are"} not assigned.`,
		);
	}
	const seen = new Set<number>();
	input.participants.forEach((participant, index) => {
		const position = index + 1;
		const displayName = participant.name.trim();
		if (displayName === "") {
			throw new StagedChatImportPlanError(
				`Participant at position ${position} requires a nonblank native name.`,
			);
		}
		if (participant.messagePositions.length === 0) {
			throw new StagedChatImportPlanError(
				`Participant "${displayName}" owns no Messages; every resulting Participant must retain at least one Message.`,
			);
		}
		for (const messagePosition of participant.messagePositions) {
			if (
				!Number.isInteger(messagePosition) ||
				messagePosition < 1 ||
				messagePosition > messageCount
			) {
				throw new StagedChatImportPlanError(
					`Participant "${displayName}" references an unknown Message position ${messagePosition}.`,
				);
			}
			if (seen.has(messagePosition)) {
				throw new StagedChatImportPlanError(
					`Message at position ${messagePosition} is assigned to more than one Participant.`,
				);
			}
			seen.add(messagePosition);
		}
		if (
			participant.outcome.type === "fork" &&
			!Number.isInteger(participant.outcome.characterId)
		) {
			throw new StagedChatImportPlanError(
				`Participant "${displayName}" selected an invalid Character.`,
			);
		}
	});
	if (seen.size !== messageCount) {
		const unassigned = messageCount - seen.size;
		throw new StagedChatImportPlanError(
			`Every Message must belong to exactly one Participant; ${unassigned} Message${unassigned === 1 ? "" : "s"} remain unassigned.`,
		);
	}
	// Exact duplicates (matching raw-byte SHA-256) require the explicit
	// Import another copy confirmation; related-source matches stay
	// advisory and never gate the commit.
	if (
		record.preview.duplicates.exact.length > 0 &&
		input.duplicateConfirmed !== true
	) {
		throw new StagedChatImportDuplicateConfirmationError();
	}
};

const emptyImportedDefinition = (name: string): ParticipantDefinition => ({
	name,
	prompt: emptyImportedPrompt(),
	openings: [],
});

// Resolves the plan into complete Participant Definitions before the exact
// artifact is finalized. Fork names come from the selected Profile's current
// name, never from the client-supplied plan name; creation and chat-only
// Participants keep the user-confirmed nonblank name with the empty imported
// Prompt. A fork whose Profile vanished since the preview is a recoverable
// plan failure, not a database operation.
const resolvePlanParticipants = (
	database: Database,
	input: ChatImportCommitInput,
): ResolvedPlanParticipant[] => {
	const library = createCharacterLibraryModule(database);
	return input.participants.map((plan, index) => {
		const displayName = plan.name.trim() || `Participant ${index + 1}`;
		if (plan.outcome.type === "fork") {
			const character = library.get(plan.outcome.characterId);
			if (character === undefined) {
				throw new StagedChatImportPlanError(
					`The Character selected for "${displayName}" no longer exists; choose an existing Character or keep a Chat-only Participant.`,
				);
			}
			return {
				plan,
				definition: {
					name: character.name,
					prompt: character.prompt,
					openings: character.openings,
				},
				sourceCharacterId: character.id,
				createProfile: false,
			};
		}
		return {
			plan,
			definition: emptyImportedDefinition(displayName),
			sourceCharacterId: null,
			createProfile: plan.outcome.type === "new-character",
		};
	});
};

// One copy warning per matching prior Chat, mirroring the developer import
// path so the persisted report and receipt stay consistent across both
// import surfaces. Exact and related matches both describe an independent
// copy; only exact matches demanded confirmation.
const duplicateCopyWarnings = (
	duplicates: ChatImportPreview["duplicates"],
): string[] =>
	[...duplicates.exact, ...duplicates.related].map(
		(match) =>
			`Source was already imported as chat ${match.id} ("${match.name}"); this import creates an independent copy.`,
	);

// Maps each 1-based record position to the seed index of the Participant
// that owns it. Plan validation guarantees a complete, non-overlapping
// assignment, so every retained position resolves.
const assignMessageOwners = (
	participants: readonly ChatImportResolvedParticipantPlan[],
): Map<number, number> => {
	const owners = new Map<number, number>();
	participants.forEach((participant, index) => {
		for (const position of participant.messagePositions) {
			owners.set(position, index);
		}
	});
	return owners;
};

// A finalized managed copy: everything the exact artifact metadata row
// needs, derived from the same staged bytes that produced the preview.
interface FinalizedExactArtifact {
	relativePath: string;
	byteLength: number;
	sha256: string;
}

// The exact staged bytes are moved into a unique managed relative path
// after plan validation and before any database operation. A failure here
// aborts with no Chat, Participant, Profile, Message, Variant, Roster,
// Author Stamp, or artifact metadata row created. If the database commit
// fails later, the already moved file may remain unused; no recovery
// journal or garbage collector is added.
const finalizeExactArtifact = (
	artifactDirectory: string,
	record: StagedRecord,
): FinalizedExactArtifact => {
	try {
		const relativePath = uniqueManagedRelativePath(record.originalFilename);
		// The staging root lives under the same managed artifact directory
		// (created when the module was constructed), so this is a
		// same-filesystem rename, not a copy.
		renameSync(record.stagedPath, join(artifactDirectory, relativePath));
		return {
			relativePath,
			byteLength: record.byteLength,
			sha256: record.sha256,
		};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new SillyTavernImportError(
			`Could not preserve the exact source artifact: ${detail}`,
		);
	}
};

export function createChatImportModule(
	database: Database,
	options: ChatImportModuleOptions,
): ChatImportModule {
	const artifactDirectory = options.artifactDirectory;
	const stagingRoot = join(artifactDirectory, "staging");
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

		commit(token, input) {
			const committed = committedResults.get(token);
			if (committed !== undefined) return committed;

			const record = stagedRegistry.get(token);
			if (record === undefined) {
				throw new StagedChatImportExpiredError();
			}
			if (input.sha256 !== record.sha256) {
				throw new StagedChatImportTokenMismatchError();
			}
			const status = verifyStagedBytes(record);
			if (status !== "available") {
				throw new StagedChatImportUnavailableError(status);
			}

			// Re-decode the exact staged bytes that produced the preview, so
			// the committed Chat is always the previewed one. Awaiting no
			// reopening of the user's original file: the flow works from the
			// staged copy alone.
			const stagedBytes = readFileSync(record.stagedPath);
			const sourceText = decodeSillyTavernSourceBytes(stagedBytes);
			const decoded = decodeSillyTavernImportSource(sourceText, {
				name: chatNameFromFilename(record.originalFilename),
				filename: record.originalFilename,
				sha256: record.sha256,
			});
			const messageCount = decoded.report.counts.messages;

			// Plan validation and Profile resolution are fully recoverable:
			// nothing is written and the staged bytes are untouched.
			validateResolutionPlan(record, messageCount, input);
			const resolved = resolvePlanParticipants(database, input);

			// The managed exact artifact is finalized before the database
			// operation; a failure here creates no database state.
			const stored = finalizeExactArtifact(artifactDirectory, record);

			const finalWarnings = [
				...decoded.report.warnings,
				...duplicateCopyWarnings(record.preview.duplicates),
			];
			const finalReport = {
				...decoded.report,
				warnings: finalWarnings,
			};
			const owners = assignMessageOwners(input.participants);
			const messages = decoded.messages.map((message, index) => {
				// SAFETY: plan validation assigned every retained position to
				// exactly one Participant, so every owner exists.
				const owner = owners.get(index + 1) as number;
				return { ...message, authorParticipantIndex: owner };
			});

			// One all-or-nothing SQLite operation through public domain
			// seams: requested new Profiles and the Chat itself commit
			// together or not at all. Bun's nested database.transaction calls
			// are savepoint-backed, so the inner Character creation and the
			// Conversation creation roll back together when either fails.
			const commit = database.transaction(() => {
				const seeds: ConversationParticipantSeed[] = resolved.map((entry) => {
					if (!entry.createProfile) {
						return {
							definition: entry.definition,
							sourceCharacterId:
								entry.sourceCharacterId ?? undefined,
						};
					}
					// Creating a new Character during resolution creates the
					// Participant and a separate minimal Actor Profile in the
					// same database commit. Duplicate Profile names are allowed;
					// no uniqueness is enforced and no suffix is appended.
					const created = createCharacterLibraryModule(database).execute({
						type: "create",
						definition: {
							name: entry.definition.name,
							prompt: entry.definition.prompt,
							openings: entry.definition.openings,
						},
					});
					return {
						definition: entry.definition,
						sourceCharacterId: created.id,
					};
				});

				return createConversationModule(database).create({
					name: input.title.trim(),
					participants: seeds,
					// Deterministic import Control on first resolved
					// Participant appearance: the first becomes human, the
					// second model, later Participants stay unseated, and a
					// zero- or one-Participant import commits as the
					// incomplete-Conversation exception with playability
					// derived once the missing seat is filled.
					control: deterministicImportControl(seeds.length),
					messages,
					data: [...decoded.data, ...importReportEntries(finalReport)],
					artifacts: [
						{
							namespace: EXACT_SOURCE_ARTIFACT_NAMESPACE,
							key: EXACT_SOURCE_ARTIFACT_KEY,
							relativePath: stored.relativePath,
							originalFilename: record.originalFilename,
							mediaType: mediaTypeFromFilename(record.originalFilename),
							byteLength: stored.byteLength,
							sha256: stored.sha256,
						},
					],
				});
			});
			const conversation = commit.immediate();

			const receipt: ChatImportReceipt = {
				conversationId: conversation.id,
				title: conversation.name,
				originalFilename: record.originalFilename,
				sha256: record.sha256,
				byteLength: record.byteLength,
				counts: { ...decoded.report.counts },
				participants: resolved.map((entry, index) => ({
					// The committed Cast is authoritative: a created Profile's id is
					// assigned inside the transaction, so provenance comes from the
					// committed Participant rather than the pre-commit plan.
					name: conversation.cast[index]?.name ?? entry.definition.name,
					outcome: entry.plan.outcome.type,
					sourceCharacterId:
						conversation.cast[index]?.sourceCharacterId ?? null,
				})),
				warnings: finalWarnings,
				duplicates: {
					exact: record.preview.duplicates.exact.map((match) => ({ ...match })),
					related: record.preview.duplicates.related.map((match) => ({
						...match,
					})),
				},
			};
			const result: ChatImportCommitResult = { conversation, receipt };
			// Consume the token once while retaining its successful result
			// for idempotent retry.
			committedResults.set(token, result);
			stagedRegistry.delete(token);
			return result;
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