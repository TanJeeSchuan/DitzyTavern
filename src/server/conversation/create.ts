import type { Database } from "bun:sqlite";
import {
	compileOpening,
	type MacroContext,
} from "../prompt-compiler";
import {
	artifactTable,
	chatDataTable,
	chatTable,
	conversationGenerationSettingsTable,
	conversationControlTable,
	messageDataTable,
	messageVariantDataTable,
} from "../database/schema";
import { InvalidConversationCreationError } from "./errors";
import {
	insertMessage,
	insertParticipant,
	insertVariants,
	normalizeParticipantName,
	type ConversationDatabase,
} from "./internal";
import { readConversationSnapshot } from "./snapshot";
import { runConversationTransaction } from "./commands/transaction";
import type {
	ConversationArtifactSeed,
	ConversationCreationInput,
	ConversationCreationMessage,
	ConversationDataEntry,
	ConversationSnapshot,
	ParticipantDefinition,
} from "./types";

const validateArtifact = (
	artifact: ConversationArtifactSeed,
	position: number,
) => {
	if (
		artifact.namespace.trim() === "" ||
		artifact.key.trim() === "" ||
		artifact.relativePath.trim() === "" ||
		artifact.originalFilename.trim() === "" ||
		artifact.mediaType.trim() === ""
	) {
		throw new InvalidConversationCreationError(
			`Artifact at position ${position} requires nonblank namespace, key, managed relative path, original filename, and media type.`,
		);
	}
	if (!Number.isInteger(artifact.byteLength) || artifact.byteLength < 0) {
		throw new InvalidConversationCreationError(
			`Artifact at position ${position} has an invalid byte length.`,
		);
	}
	// ==[HUMAN APPROVED]== The raw-byte SHA-256 is the verification authority for the exact
	// stored artifact; a malformed digest cannot be verified later.
	if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) {
		throw new InvalidConversationCreationError(
			`Artifact at position ${position} has an invalid SHA-256 value.`,
		);
	}
};

const validateArtifacts = (artifacts: readonly ConversationArtifactSeed[]) => {
	const identities = new Set<string>();
	artifacts.forEach((artifact, index) => {
		const position = index + 1;
		validateArtifact(artifact, position);
		// ==[HUMAN APPROVED]== Artifact identity is unique within the Conversation by (namespace,
		// key); the structural unique index enforces the same rule across
		// separate creations.
		const identity = `${artifact.namespace}\u0000${artifact.key}`;
		if (identities.has(identity)) {
			throw new InvalidConversationCreationError(
				`Artifact at position ${position} duplicates the (namespace, key) identity of an earlier artifact.`,
			);
		}
		identities.add(identity);
	});
};

const insertArtifacts = (
	db: ConversationDatabase,
	conversationId: number,
	artifacts: readonly ConversationArtifactSeed[],
) => {
	if (artifacts.length === 0) return;
	db.insert(artifactTable)
		.values(
			artifacts.map((artifact) => ({
				chat_id: conversationId,
				namespace: artifact.namespace,
				key: artifact.key,
				relative_path: artifact.relativePath,
				original_filename: artifact.originalFilename,
				media_type: artifact.mediaType,
				byte_length: artifact.byteLength,
				sha256: artifact.sha256,
			})),
		)
		.run();
};

const validateDefinition = (
	position: number,
	definition: ParticipantDefinition,
) => {
	if (normalizeParticipantName(definition.name) === "") {
		throw new InvalidConversationCreationError(
			`Participant at Cast position ${position} requires a nonblank name.`,
		);
	}
	definition.openings.forEach((opening, index) => {
		if (opening.trim() === "") {
			throw new InvalidConversationCreationError(
				`Participant at Cast position ${position} has a blank opening at position ${
					index + 1
				}; openings must contain text.`,
			);
		}
	});
};

const validateMessage = (
	message: ConversationCreationMessage,
	position: number,
	participantCount: number,
) => {
	if (message.variants.length === 0) {
		throw new InvalidConversationCreationError(
			`Message at position ${position} has no Variants.`,
		);
	}
	const selectedCount = message.variants.filter(
		(variant) => variant.selected,
	).length;
	if (selectedCount !== 1) {
		throw new InvalidConversationCreationError(
			`Message at position ${position} must have exactly one selected Variant, but ${selectedCount} are selected.`,
		);
	}
	if (message.authorParticipantIndex !== undefined) {
		const index = message.authorParticipantIndex;
		if (
			!Number.isInteger(index) ||
			index < 0 ||
			index >= participantCount
		) {
			throw new InvalidConversationCreationError(
				`Message at position ${position} references an author Participant outside the created Cast.`,
			);
		}
	}
};

const chronological = (a: string, b: string) =>
	Date.parse(a) - Date.parse(b);

interface DerivedTimes {
	creationTime: string;
	lastMessageTime: string;
}

const deriveChatTimes = (
	messages: readonly ConversationCreationMessage[],
	fallbackTime: string,
): DerivedTimes => {
	const messageTimestamps = messages.map((message) => message.timestamp);
	const variantTimestamps = messages.flatMap((message) =>
		message.variants.map((variant) => variant.timestamp),
	);
	return {
		creationTime:
			messageTimestamps.length > 0
				? [...messageTimestamps].sort(chronological)[0]
				: fallbackTime,
		lastMessageTime:
			variantTimestamps.length > 0
				? [...variantTimestamps].sort(chronological)[
						variantTimestamps.length - 1
					]
				: fallbackTime,
	};
};

const insertScopedData = <Owner extends object>(
	data: readonly ConversationDataEntry[] | undefined,
	toRow: (entry: ConversationDataEntry) => Owner,
	insert: (rows: Owner[]) => void,
) => {
	if (data === undefined || data.length === 0) return;
	insert(data.map(toRow));
};

// ==[HUMAN APPROVED]== Native creation converts the initial model Participant's ordered openings
// into one Message whose sibling Variants match the openings and whose first
// Variant is selected. No openings produce no Message. Openings are used only
// during creation: later Cast or Control changes never author history.
const deriveGreetingFromInput = (
	input: ConversationCreationInput,
	baseTime: string,
): ConversationCreationMessage | null => {
	const participants = input.participants ?? [];
	if (
		input.control === undefined ||
		(input.messages?.length ?? 0) > 0 ||
		input.control.human === undefined ||
		input.control.model === undefined
	) {
		// ==[HUMAN APPROVED]== No greeting without a complete human/model pair: partial Control
		// seeds belong to the incomplete-import completion path, where the
		// imported history is explicit and no greeting is ever derived.
		return null;
	}
	const modelSeed = participants[input.control.model];
	const humanSeed = participants[input.control.human];
	const openings = [...(modelSeed?.definition.openings ?? [])];
	if (openings.length === 0) return null;

	// ==[HUMAN APPROVED]== The greeting is the first compiled use of the model seat's openings:
	// macros resolve relative to the owning model Definition. The stored
	// openings stay raw; only the presented greeting text is expanded.
	const context: MacroContext = {
		self: normalizeParticipantName(modelSeed.definition.name),
		other: normalizeParticipantName(humanSeed.definition.name),
	};

	return {
		timestamp: baseTime,
		variants: openings.map((content, index) => ({
			content: compileOpening(content, context, index + 1).text,
			timestamp: baseTime,
			selected: index === 0,
		})),
	};
};

export function createConversation(
	database: Database,
	input: ConversationCreationInput,
): ConversationSnapshot {
	return runConversationTransaction(database, (db) => {
		const seeds = input.participants ?? [];
		seeds.forEach((seed, index) =>
			validateDefinition(index + 1, seed.definition),
		);
		seeds.forEach((seed) => {
			if (
				seed.sourceCharacterId !== undefined &&
				!Number.isInteger(seed.sourceCharacterId)
			) {
				throw new InvalidConversationCreationError(
					"Provenance must reference an existing Character.",
				);
			}
		});

		let humanIndex: number | undefined;
		let modelIndex: number | undefined;
		if (input.control !== undefined) {
			humanIndex = input.control.human;
			modelIndex = input.control.model;
			const requireSeatInCast = (index: number | undefined) => {
				if (index === undefined) return;
				if (
					!Number.isInteger(index) ||
					index < 0 ||
					index >= seeds.length
				) {
					throw new InvalidConversationCreationError(
						"Control seats must reference Participants of the created Cast.",
					);
				}
			};
			requireSeatInCast(humanIndex);
			requireSeatInCast(modelIndex);
			if (humanIndex !== undefined && modelIndex !== undefined) {
				if (humanIndex === modelIndex) {
					throw new InvalidConversationCreationError(
						"The human and model seats must be held by distinct Participants.",
					);
				}
			} else if (humanIndex === undefined && modelIndex === undefined) {
				// ==[HUMAN APPROVED]== Empty control seeds are a caller mistake: the incomplete-import
				// exception fills one seat, never zero.
				throw new InvalidConversationCreationError(
					"Control seeds must occupy at least one seat.",
				);
			}
		}

		const explicitMessages = input.messages ?? [];
		explicitMessages.forEach((message, index) =>
			validateMessage(message, index + 1, seeds.length),
		);

		const artifacts = input.artifacts ?? [];
		validateArtifacts(artifacts);

		const baseTime = input.createdAt ?? new Date().toISOString();
		const greeting =
			explicitMessages.length === 0
				? deriveGreetingFromInput(input, baseTime)
				: null;
		const messages: readonly ConversationCreationMessage[] =
			greeting !== null ? [greeting] : explicitMessages;

		const { creationTime, lastMessageTime } = deriveChatTimes(messages, baseTime);
		const conversation = db
			.insert(chatTable)
			.values({
				name: input.name,
				creation_time: creationTime,
				last_message_time: lastMessageTime,
			})
			.returning({ id: chatTable.id })
			.get();
		if (conversation === undefined) {
			throw new InvalidConversationCreationError(
				"Conversation insertion did not return an identifier.",
			);
		}
		db.insert(conversationGenerationSettingsTable)
			.values({ chat_id: conversation.id })
			.run();

		// ==[HUMAN APPROVED]== Insert the Cast so Control and the greeting can reference stable
		// Participant identifiers. Insertion failures surface as the creation
		// error class so the transport contracts map them to 422.
		const insertedParticipants = seeds.map((seed, index) =>
			insertParticipant(
				db,
				conversation.id,
				index + 1,
				seed.definition,
				seed.sourceCharacterId ?? null,
				InvalidConversationCreationError,
			),
		);

		const controlRows = [];
		if (humanIndex !== undefined) {
			controlRows.push({
				chat_id: conversation.id,
				seat: "human" as const,
				participant_id: insertedParticipants[humanIndex].id,
			});
		}
		if (modelIndex !== undefined) {
			controlRows.push({
				chat_id: conversation.id,
				seat: "model" as const,
				participant_id: insertedParticipants[modelIndex].id,
			});
		}
		if (controlRows.length > 0) {
			db.insert(conversationControlTable).values(controlRows).run();
		}

		insertScopedData(
			input.data,
			(entry) => ({ ...entry, chat_id: conversation.id }),
			(rows) => db.insert(chatDataTable).values(rows).run(),
		);

		// ==[HUMAN APPROVED]== Artifact metadata rows are Conversation database state and commit
		// with the rest of the creation; the physical bytes stay outside the
		// transaction under the managed relative path.
		insertArtifacts(db, conversation.id, artifacts);

		for (const [messageIndex, message] of messages.entries()) {
			const greetingMessage = greeting !== null && messageIndex === 0;
			const authorSeed = greetingMessage
				? modelIndex !== undefined
					? insertedParticipants[modelIndex]
					: undefined
				: message.authorParticipantIndex !== undefined
					? insertedParticipants[message.authorParticipantIndex]
					: undefined;
			// ==[HUMAN APPROVED]== The greeting carries the historical Control pair captured at
			// creation; preservation records never receive a fabricated pair.
			const context =
				greetingMessage &&
				humanIndex !== undefined &&
				modelIndex !== undefined
					? {
							humanParticipantId: insertedParticipants[humanIndex].id,
							modelParticipantId: insertedParticipants[modelIndex].id,
						}
					: null;

			const messageId = insertMessage(
				db,
				{
					chatId: conversation.id,
					position: messageIndex + 1,
					timestamp: message.timestamp,
					author: authorSeed
						? { participantId: authorSeed.id, name: authorSeed.name }
						: null,
					context,
				},
				InvalidConversationCreationError,
			);

			insertScopedData(
				message.data,
				(entry) => ({ ...entry, message_id: messageId }),
				(rows) => db.insert(messageDataTable).values(rows).run(),
			);

			const variantIds = insertVariants(
				db,
				message.variants.map((variant, variantIndex) => ({
					messageId,
					position: variantIndex + 1,
					content: variant.content,
					timestamp: variant.timestamp,
					selected: variant.selected,
				})),
			);

			const variantData = message.variants.flatMap((variant, variantIndex) => {
				const variantId = variantIds[variantIndex];
				if (variant.data === undefined) return [];
				return variant.data.map((entry) => ({
					...entry,
					message_variant_id: variantId,
				}));
			});
			if (variantData.length > 0) {
				db.insert(messageVariantDataTable).values(variantData).run();
			}
		}

		const snapshot = readConversationSnapshot(db, conversation.id);
		if (snapshot === undefined) {
			throw new InvalidConversationCreationError(
				"Created Conversation could not be read back.",
			);
		}
		return snapshot;
	});
}
