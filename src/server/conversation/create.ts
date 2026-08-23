import type { Database } from "bun:sqlite";
import {
	compileOpening,
	type MacroContext,
} from "../prompt-compiler";
import {
	chatDataTable,
	chatTable,
	conversationControlTable,
	messageDataTable,
	messageTable,
	messageVariantDataTable,
	messageVariantTable,
	participantOpeningTable,
	participantPromptTable,
	participantTable,
} from "../database/schema";
import { InvalidConversationCreationError } from "./errors";
import { type ConversationDatabase, connectConversationDatabase } from "./internal";
import { readConversationSnapshot } from "./snapshot";
import type {
	ConversationCreationInput,
	ConversationCreationMessage,
	ConversationDataEntry,
	ConversationSnapshot,
	ParticipantDefinition,
} from "./types";

// Names follow the shared Definition rules: surrounding whitespace removed
// while case and Unicode are preserved; a nonblank result is required.
export const normalizeParticipantName = (name: string) => name.trim();

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

const validateMessage = (message: ConversationCreationMessage, position: number) => {
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

interface InsertedParticipant {
	id: number;
	name: string;
	openings: readonly string[];
}

const insertParticipant = (
	db: ConversationDatabase,
	conversationId: number,
	position: number,
	definition: ParticipantDefinition,
	sourceCharacterId: number | null,
): InsertedParticipant => {
	const name = normalizeParticipantName(definition.name);
	const inserted = db
		.insert(participantTable)
		.values({
			chat_id: conversationId,
			name,
			position,
			source_character_id: sourceCharacterId,
		})
		.returning({ id: participantTable.id })
		.get();
	if (inserted === undefined) {
		throw new InvalidConversationCreationError(
			"Participant insertion did not return an identifier.",
		);
	}

	db.insert(participantPromptTable)
		.values({
			participant_id: inserted.id,
			system_instruction: definition.prompt.systemInstruction,
			identity: definition.prompt.identity,
			scenario: definition.prompt.scenario,
			example_dialogue: definition.prompt.exampleDialogue,
			post_history_instruction: definition.prompt.postHistoryInstruction,
		})
		.run();

	const openings = [...definition.openings];
	if (openings.length > 0) {
		db.insert(participantOpeningTable)
			.values(
				openings.map((content, index) => ({
					participant_id: inserted.id,
					position: index + 1,
					content,
				})),
			)
			.run();
	}

	return { id: inserted.id, name, openings };
};

// Native creation converts the initial model Participant's ordered openings
// into one Message whose sibling Variants match the openings and whose first
// Variant is selected. No openings produce no Message. Openings are used only
// during creation: later Cast or Control changes never author history.
const deriveGreetingFromInput = (
	input: ConversationCreationInput,
	baseTime: string,
): ConversationCreationMessage | null => {
	const participants = input.participants ?? [];
	if (input.control === undefined || (input.messages?.length ?? 0) > 0) {
		return null;
	}
	const modelSeed = participants[input.control.model];
	const humanSeed = participants[input.control.human];
	const openings = [...(modelSeed?.definition.openings ?? [])];
	if (openings.length === 0) return null;

	// The greeting is the first compiled use of the model seat's openings:
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
	const db = connectConversationDatabase(database);
	const create = database.transaction(() => {
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
			if (
				!Number.isInteger(humanIndex) ||
				humanIndex < 0 ||
				humanIndex >= seeds.length ||
				!Number.isInteger(modelIndex) ||
				modelIndex < 0 ||
				modelIndex >= seeds.length
			) {
				throw new InvalidConversationCreationError(
					"Control seats must reference Participants of the created Cast.",
				);
			}
			if (humanIndex === modelIndex) {
				throw new InvalidConversationCreationError(
					"The human and model seats must be held by distinct Participants.",
				);
			}
		}

		const explicitMessages = input.messages ?? [];
		explicitMessages.forEach((message, index) =>
			validateMessage(message, index + 1),
		);

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

		// Insert the Cast so Control and the greeting can reference stable
		// Participant identifiers.
		const insertedParticipants = seeds.map((seed, index) =>
			insertParticipant(
				db,
				conversation.id,
				index + 1,
				seed.definition,
				seed.sourceCharacterId ?? null,
			),
		);

		if (humanIndex !== undefined && modelIndex !== undefined) {
			db.insert(conversationControlTable)
				.values([
					{
						chat_id: conversation.id,
						seat: "human",
						participant_id: insertedParticipants[humanIndex].id,
					},
					{
						chat_id: conversation.id,
						seat: "model",
						participant_id: insertedParticipants[modelIndex].id,
					},
				])
				.run();
		}

		insertScopedData(
			input.data,
			(entry) => ({ ...entry, chat_id: conversation.id }),
			(rows) => db.insert(chatDataTable).values(rows).run(),
		);

		for (const [messageIndex, message] of messages.entries()) {
			const greetingMessage = greeting !== null && messageIndex === 0;
			const author =
				greetingMessage && modelIndex !== undefined
					? insertedParticipants[modelIndex]
					: undefined;
			// The greeting carries the historical Control pair captured at
			// creation; preservation records never receive a fabricated pair.
			const contextHumanId =
				greetingMessage && humanIndex !== undefined
					? insertedParticipants[humanIndex].id
					: null;
			const contextModelId =
				greetingMessage && modelIndex !== undefined
					? insertedParticipants[modelIndex].id
					: null;

			const insertedMessage = db
				.insert(messageTable)
				.values({
					chat_id: conversation.id,
					position: messageIndex + 1,
					timestamp: message.timestamp,
					author_participant_id: author?.id ?? null,
					author_name: author?.name ?? null,
					context_human_participant_id: contextHumanId,
					context_model_participant_id: contextModelId,
				})
				.returning({ id: messageTable.id })
				.get();

			insertScopedData(
				message.data,
				(entry) => ({ ...entry, message_id: insertedMessage.id }),
				(rows) => db.insert(messageDataTable).values(rows).run(),
			);

			const insertedVariants = db
				.insert(messageVariantTable)
				.values(
					message.variants.map((variant, variantIndex) => ({
						message_id: insertedMessage.id,
						position: variantIndex + 1,
						content: variant.content,
						timestamp: variant.timestamp,
						selected: variant.selected,
					})),
				)
				.returning({ id: messageVariantTable.id })
				.all();

			const variantData = message.variants.flatMap((variant, variantIndex) => {
				const variantId = insertedVariants[variantIndex]?.id;
				if (variantId === undefined || variant.data === undefined) return [];
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

	return create.immediate();
}
