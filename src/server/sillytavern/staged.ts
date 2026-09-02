// ==[HUMAN APPROVED]== User-facing staged Chat import: choose one file, stream its bytes into
// their final managed artifact path exactly once, validate the complete
// source before any Participant resolution, and return a reviewable preview
// bound to the exact byte length and SHA-256 that were uploaded.
//
// This is the deep behavioral seam for the import flow: it composes only
// public capabilities (the SillyTavern adapter for validation, the
// Character Library for name-only suggestions, and the prior-import
// classifier for duplicate evidence). It creates no native Chat, no
// Participant, no Actor Profile, and no artifact metadata row; the previewed
// source stays session-bound at its managed path until commit.
//
// Staging is session-bound by construction: staged handles and committed
// receipts live in one process-level expiring session store. A server
// restart naturally expires every staged flow and requires file reselection;
// no durable import draft or resume system is added. Every session also
// expires on its own after the documented TTL: a lazy sweep on every module
// access plus an opportunistic periodic sweep evicts expired sessions and
// deletes their staged files, so abandoned flows never pin memory or
// unclaimed artifact bytes. Discard (explicit cancellation) removes only
// the uncommitted staged bytes of that one flow.
//
// Commit is atomic across filesystem and SQLite without a finalization step:
// the immutable staged managed path becomes the final artifact path, and the
// commit transaction claims it in place (the artifact metadata row
// references it). A failed database operation claims nothing, so the still-
// staged bytes keep serving a corrected retry until the session expires,
// when the expiring sweep collects the never-claimed path.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Database } from "bun:sqlite";
import { mediaTypeFromFilename, sha256Hex, uniqueManagedRelativePath } from "../artifact";
import { createCharacterLibraryModule } from "../character-library";
import type { ParticipantDefinition } from "../conversation/types";
import { createConversationModule } from "../conversation";
import { withDatabase } from "../database/database";
import { createImportedConversation } from "../workflows";
import {
	EXACT_SOURCE_ARTIFACT_KEY,
	EXACT_SOURCE_ARTIFACT_NAMESPACE,
	decodeSillyTavernImportSource,
	decodeSillyTavernSourceBytes,
	inspectSillyTavernChatJsonl,
	type SillyTavernChatInspection,
} from "./adapter";
import {
	emptyImportedDefinition,
	projectImport,
	type ImportProjectionResolution,
} from "./import-projection";
import {
	StagedChatImportDuplicateConfirmationError,
	StagedChatImportExpiredError,
	StagedChatImportPlanError,
	StagedChatImportTokenMismatchError,
	StagedChatImportUnavailableError,
	SillyTavernImportError,
} from "./errors";
import { chatNameFromFilename } from "./import";

import { buildPreview } from "./staged/preview";
import type {
	ChatImportCommitInput,
	ChatImportModule,
	ChatImportModuleOptions,
	ChatImportReceipt,
	ChatImportResolvedParticipantPlan,
	StagedRecord,
} from "./staged/types";

export * from "./staged/types";

// ==[HUMAN APPROVED]== One expiring import-session store. Process-level so every request-scoped
// module instance shares the same handles, and a server restart clears it
// wholesale (the expiry contract). Both session phases live in this one
// map, and every entry carries its own absolute expiry: the staged handle
// from its staging time, and the compact committed receipt kept for
// idempotent retry from its commit.
type StagedImportSession =
	| { phase: "staged"; expiresAt: number; record: StagedRecord }
	| { phase: "committed"; expiresAt: number; receipt: ChatImportReceipt };

const stagedImportSessions = new Map<string, StagedImportSession>();

// ==[HUMAN APPROVED]== An interactive staging flow (upload, resolve Participants, confirm, commit)
// fits comfortably inside this window; anything older is abandoned work that
// must not keep staged bytes or receipts alive.
export const STAGED_IMPORT_SESSION_TTL_MS = 60 * 60 * 1000;

// ==[HUMAN APPROVED]== The scheduled sweep is the safety net for sessions whose tokens are never
// touched again: lazy sweeps run only when some request arrives, so a flow
// abandoned mid-resolution would otherwise keep its staged file forever.
const STAGED_IMPORT_SWEEP_INTERVAL_MS = 60 * 1000;

// ==[HUMAN APPROVED]== Evicts every session past its expiry and deletes the staged file of each
// evicted staged handle; an evicted committed receipt leaves nothing on
// disk, so only the map entry goes. `now` is injectable for tests.
export const sweepExpiredImportSessions = (now: number = Date.now()): void => {
	for (const [token, session] of stagedImportSessions) {
		if (session.expiresAt > now) continue;
		if (session.phase === "staged") {
			rmSync(session.record.stagedPath, { force: true });
		}
		stagedImportSessions.delete(token);
	}
};

let sweepTimer: ReturnType<typeof setInterval> | undefined;
const ensureScheduledImportSweep = (): void => {
	if (sweepTimer !== undefined) return;
	// Unref'd: the sweep must never keep a process (or a test run) alive. ==[HUMAN APPROVED]==
	sweepTimer = setInterval(
		sweepExpiredImportSessions,
		STAGED_IMPORT_SWEEP_INTERVAL_MS,
	);
	sweepTimer.unref();
};

// ==[HUMAN APPROVED]== Simulates the restart expiry for tests: drops every staged handle and
// every retained committed receipt without touching the already staged or
// committed files (a real restart runs no cleanup either; orphaned files
// are an accepted lifecycle tradeoff with no GC).
export const clearStagedImportRegistry = (): void => {
	stagedImportSessions.clear();
};

// ==[HUMAN APPROVED]== Streams the uploaded bytes into their staged managed path while hashing
// them in flight, so neither the HTTP boundary nor this module buffers the
// complete artifact in memory. Node's pipeline owns backpressure and
// propagates reader or writer failures to the call-site cleanup path.
const streamToStagedFile = async (
	path: string,
	bytes: ReadableStream<Uint8Array>,
): Promise<{ byteLength: number; sha256: string }> => {
	const hash = createHash("sha256");
	let byteLength = 0;
	const hashing = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			hash.update(chunk);
			byteLength += chunk.byteLength;
			callback(null, chunk);
		},
	});
	await pipeline(
		// ==[HUMAN APPROVED]== Bun's Web ReadableStream is runtime-compatible with Node's
		// WebReadableStream; the declarations differ only in their convenience methods.
		// @ts-expect-error
		Readable.fromWeb(bytes),
		hashing,
		createWriteStream(path, { flags: "wx" }),
	);
	return { byteLength, sha256: hash.digest("hex") };
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

// ==[HUMAN APPROVED]== A staged handle whose bytes are missing or no longer match the binding
// can serve neither a preview nor a commit; the typed unavailable error
// names the reason.
const assertStagedAvailable = (record: StagedRecord): void => {
	const status = verifyStagedBytes(record);
	if (status !== "available") {
		throw new StagedChatImportUnavailableError(status);
	}
};


interface ResolvedPlanParticipant {
	plan: ChatImportResolvedParticipantPlan;
	definition: ParticipantDefinition;
	sourceCharacterId: number | null;
	// ==[HUMAN APPROVED]== True when the resolution creates a new Actor Profile in the same
	// database operation as the Chat; the created Profile becomes the
	// Participant's immutable provenance source, exactly like a fork.
	createProfile: boolean;
}

// ==[HUMAN APPROVED]== Structural validation of the user-confirmed plan. Runs entirely before
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
	// ==[HUMAN APPROVED]== Exact duplicates (matching raw-byte SHA-256) require the explicit
	// Import another copy confirmation; related-source matches stay
	// advisory and never gate the commit.
	if (
		record.preview.duplicates.exact.length > 0 &&
		input.duplicateConfirmed !== true
	) {
		throw new StagedChatImportDuplicateConfirmationError();
	}
};

// ==[HUMAN APPROVED]== Resolves the plan into complete Participant Definitions before the exact
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
	return input.participants.map((plan) => {
		const displayName = plan.name.trim();
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

// ==[HUMAN APPROVED]== Maps each 1-based record position to the seed index of the Participant
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

// ==[HUMAN APPROVED]== The exact staged bytes already sit at their unique managed path, and that
// immutable staged path is the final artifact path: the commit transaction
// claims it in place by referencing it from the artifact metadata row. No
// file move, copy, or finalization precedes the database operation, so a
// database failure claims nothing: the still-staged session keeps serving a
// corrected retry from the same bytes, and the expiring sweep collects the
// never-claimed path at expiry.

export function createChatImportModule(
	database: Database,
	options: ChatImportModuleOptions,
): ChatImportModule {
	const artifactDirectory = options.artifactDirectory;
	mkdirSync(artifactDirectory, { recursive: true });

	return {
		async stageFile({ bytes, originalFilename }) {
			ensureScheduledImportSweep();
			sweepExpiredImportSessions();
			const filename = basename(originalFilename);
			// ==[HUMAN APPROVED]== The upload lands directly at its final unique managed path; the
			// commit transaction claims this exact path in place.
			const relativePath = uniqueManagedRelativePath(filename);
			const stagedPath = join(artifactDirectory, relativePath);
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
				// ==[HUMAN APPROVED]== Validation failure discards the uploaded staging bytes so a
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
			stagedImportSessions.set(token, {
				phase: "staged",
				expiresAt: Date.now() + STAGED_IMPORT_SESSION_TTL_MS,
				record: {
					token,
					originalFilename: filename,
					byteLength: staged.byteLength,
					sha256: staged.sha256,
					integrity: inspection.report.source.integrity ?? null,
					stagedPath,
					relativePath,
					preview,
				},
			});
			return { token, preview };
		},

		preview(token, expectedSha256) {
			sweepExpiredImportSessions();
			const session = stagedImportSessions.get(token);
			if (session === undefined || session.phase !== "staged") {
				throw new StagedChatImportExpiredError();
			}
			const record = session.record;
			if (expectedSha256 !== undefined && expectedSha256 !== record.sha256) {
				throw new StagedChatImportTokenMismatchError();
			}
			assertStagedAvailable(record);
			return record.preview;
		},

		commit(token, input) {
			sweepExpiredImportSessions();
			const session = stagedImportSessions.get(token);
			// ==[HUMAN APPROVED]== A consumed token is a committed token: its compact receipt serves
			// the idempotent retry after a lost response. The authoritative
			// Conversation snapshot is re-read through the Conversation seam
			// instead of retaining the full result in memory.
			if (session !== undefined && session.phase === "committed") {
				const conversation = createConversationModule(database).getSnapshot(
					session.receipt.conversationId,
				);
				if (conversation === undefined) {
					// ==[HUMAN APPROVED]== The committed Chat no longer exists, so the receipt can
					// never be served again and is evicted with it.
					stagedImportSessions.delete(token);
					throw new Error(
						`The Chat committed by this import (Conversation ${session.receipt.conversationId}) no longer exists.`,
					);
				}
				return { conversation, receipt: session.receipt };
			}
			if (session === undefined || session.phase !== "staged") {
				throw new StagedChatImportExpiredError();
			}
			const record = session.record;
			if (input.sha256 !== record.sha256) {
				throw new StagedChatImportTokenMismatchError();
			}
			assertStagedAvailable(record);

			// ==[HUMAN APPROVED]== Re-decode the exact staged bytes that produced the preview, so
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

			// ==[HUMAN APPROVED]== Plan validation and Profile resolution are fully recoverable:
			// nothing is written and the staged bytes are untouched.
			validateResolutionPlan(record, messageCount, input);
			const resolved = resolvePlanParticipants(database, input);

			// ==[HUMAN APPROVED]== The confirmed Resolved Participant Plan through the shared
			// Import Projection: ownership mapping, Definitions with
			// provenance, derived Control, stamped Messages, and the final
			// report and data entries all come from one seam. The artifact
			// entry references the immutable staged path, so the transaction
			// claims the staged bytes in place.
			const resolution: ImportProjectionResolution = {
				participants: resolved.map((entry) => ({
					definition: entry.definition,
					sourceCharacterId: entry.sourceCharacterId ?? undefined,
					createCharacter: entry.createProfile,
				})),
				messageOwners: assignMessageOwners(input.participants),
			};
			const projected = projectImport(decoded, resolution, {
				exact: record.preview.duplicates.exact,
				related: record.preview.duplicates.related,
			});

			const conversation = createImportedConversation(database, {
				name: input.title.trim(),
				participants: projected.input.participants,
				control: projected.input.control,
				messages: projected.input.messages,
				data: projected.input.data,
				artifacts: [
					{
						namespace: EXACT_SOURCE_ARTIFACT_NAMESPACE,
						key: EXACT_SOURCE_ARTIFACT_KEY,
						relativePath: record.relativePath,
						originalFilename: record.originalFilename,
						mediaType: mediaTypeFromFilename(record.originalFilename),
						byteLength: record.byteLength,
						sha256: record.sha256,
					},
				],
			});

			const receipt: ChatImportReceipt = {
				conversationId: conversation.id,
				title: conversation.name,
				originalFilename: record.originalFilename,
				sha256: record.sha256,
				byteLength: record.byteLength,
				counts: { ...decoded.report.counts },
				participants: resolved.map((entry, index) => ({
					// ==[HUMAN APPROVED]== The committed Cast is authoritative: a created Profile's id is
					// assigned inside the transaction, so provenance comes from the
					// committed Participant rather than the pre-commit plan.
					name: conversation.cast[index]?.name ?? entry.definition.name,
					outcome: entry.plan.outcome.type,
					sourceCharacterId:
						conversation.cast[index]?.sourceCharacterId ?? null,
				})),
				warnings: projected.report.warnings,
				duplicates: {
					exact: record.preview.duplicates.exact.map((match) => ({ ...match })),
					related: record.preview.duplicates.related.map((match) => ({
						...match,
					})),
				},
			};
			// ==[HUMAN APPROVED]== Consume the token once while retaining the compact receipt for
			// idempotent retry within the same session lifetime.
			stagedImportSessions.set(token, {
				phase: "committed",
				expiresAt: Date.now() + STAGED_IMPORT_SESSION_TTL_MS,
				receipt,
			});
			return { conversation, receipt };
		},

		discard(token) {
			sweepExpiredImportSessions();
			const session = stagedImportSessions.get(token);
			if (session === undefined || session.phase !== "staged") return;
			stagedImportSessions.delete(token);
			// ==[HUMAN APPROVED]== Removes only this flow's uncommitted temporary staging bytes;
			// committed artifacts are never touched here.
			rmSync(session.record.stagedPath, { force: true });
		},
	};
}

// ==[HUMAN APPROVED]== Runs one staged-import operation against a request-scoped module instance.
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
