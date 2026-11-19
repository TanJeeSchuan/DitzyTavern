import { asc, eq, getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	checkpointConversationGeneration,
	acceptGeneration,
	executeConversationCommand,
	createConversation,
	readConversationSummary,
	readSelectedHistory,
	readConversationData,
	deriveMessageSwipeEligibility,
} from "../conversation";
import type { Database } from "bun:sqlite";
import { emptyPromptChannels } from "../../shared/definition";
import { openInitializedDatabase } from "../database/database";
// oxlint-disable-next-line ditzy/no-conversation-internal-imports -- The test snapshot needs raw Message and Variant rows.
import { messageDataTable, messageTable, messageVariantTable } from "../database/schema";
// oxlint-disable-next-line ditzy/no-conversation-internal-imports -- Use the same checkpointed text as production reads.
import { liveVariantContent } from "../conversation/generation-checkpoint";
// oxlint-disable-next-line ditzy/no-conversation-internal-imports -- Keep raw Variant data in storage order.
import { loadVariantDataRows, toDataEntry } from "../conversation/message-rows";
import type { BoxId, BoxState } from "../../shared/contract/box";
import { boxInstanceEntry, boxStateEntry } from "../box/setup";
import { installBoxBlocks } from "../prompt-preset";
import { observeConversationWrites } from "../conversation";
import { ConversationNotFoundError } from "../conversation";
import type {
	ConversationCommand,
	ConversationSummary,
	ConversationCreationInput,
	ConversationParticipantSeed,
	GenerationAcceptanceCapture,
	ParticipantDefinition,
	ConversationDataEntry,
	AuthorStampSnapshot,
	HistoricalControlSnapshot,
	MessageSwipeEligibility,
} from "../conversation";

export const participantDefinition = (name: string, { prompt = emptyPromptChannels(), ...overrides }: Partial<Omit<ParticipantDefinition, "name">> = {}): ParticipantDefinition => ({
	name, prompt, sendAppearanceImages: true, openings: [], ...overrides,
});

export const participantSeed = (name: string, { sourceCharacterId, ...definition }: Partial<Omit<ParticipantDefinition, "name">> & Pick<ConversationParticipantSeed, "sourceCharacterId"> = {}): ConversationParticipantSeed => {
	const seed: ConversationParticipantSeed = { definition: participantDefinition(name, definition) };
	if (sourceCharacterId !== undefined) seed.sourceCharacterId = sourceCharacterId;
	return seed;
};

type PairChatOptions = Omit<ConversationCreationInput, "name" | "participants" | "control"> & (
	| { prompt?: ParticipantDefinition["prompt"]; participants?: never }
	| { prompt?: never; participants: readonly [ConversationParticipantSeed, ConversationParticipantSeed] }
);

export const pairChat = (
	database: Database,
	name: string,
	{ prompt, participants = [participantSeed("Writer", { prompt }), participantSeed("Maren", { prompt })], ...overrides }: PairChatOptions = {},
): TestConversationSnapshot =>
	createConversationWithHistory(database, { name, participants, control: { human: 0, model: 1 }, ...overrides });

export const shortReplyPrompt = (overrides: Partial<ParticipantDefinition["prompt"]> = {}): ParticipantDefinition["prompt"] => ({
	...emptyPromptChannels(),
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "The room is quiet.",
	postHistoryInstruction: "Continue.",
	...overrides,
});

export const acceptTestGeneration = (
	database: Database,
	chat: ConversationSummary,
	target: Exclude<Parameters<typeof acceptGeneration>[2], { kind: "sibling" }>,
	{ timestamp, seed = "test-generation-seed", ...capture }: Pick<GenerationAcceptanceCapture, "timestamp"> &
		Partial<Pick<GenerationAcceptanceCapture, "seed" | "boxRecords" | "boxTraces" | "promptPlan" | "promptInspection" | "loreActivation" | "provenance">>,
): ReturnType<typeof acceptGeneration> => {
	const human = chat.cast.find(({ id }) => id === chat.control.humanParticipantId);
	const model = chat.cast.find(({ id }) => id === chat.control.modelParticipantId);
	if (!human || !model) throw new Error("Control Participants missing.");
	return acceptGeneration(database, {
		conversationId: chat.id,
		timestamp,
		seed,
		humanParticipantId: human.id,
		modelParticipantId: model.id,
		capturedHumanName: human.name,
		capturedModelName: model.name,
		promptPlan: { blocks: [], warnings: [], images: [] },
		modelId: "fixture-model",
		promptInspection: { tokenEstimate: 0, responseBudget: 64, safetyAllowance: 0, contextLimit: 128, totalRequiredTokens: 64, omittedContext: [] },
		...capture,
	}, target);
};

export function openObservedDatabase(): Database {
	const database = openInitializedDatabase({ path: ":memory:" });
	observeConversationWrites(database, () => () => {});
	return database;
}

/** @approved
 * Test-fixture seam for suites that assert on Messages
 * after an edit. Mutations return the Conversation header only, so this applies
 * the command through the ordinary public seam and then re-reads the full
 * snapshot. It exists so tests keep exercising `execute` rather than a parallel
 * commit path, and it is therefore absent from the public barrel and every HTTP
 * route. Product code must read history through the paginated seam instead of
 * materializing whole Conversations.
 */
export function applyCommand(
	module: Database,
	command: ConversationCommand,
): TestConversationSnapshot {
	const summary = executeConversationCommand(module, command);
	return requireSnapshot(module, summary.id);
}

export function requireSnapshot(
	module: Database,
	conversationId: number,
): TestConversationSnapshot {
	const snapshot = readTestConversationSnapshot(module, conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	return snapshot;
}

export interface TestConversationVariant {
 id: number;
 position: number;
 content: string;
 timestamp: string;
 selected: boolean;
 data: ConversationDataEntry[];
}
export interface TestConversationMessage {
 id: number;
 position: number;
 timestamp: string;
 author: AuthorStampSnapshot | null;
 historicalContext: HistoricalControlSnapshot | null;
 swipe: MessageSwipeEligibility;
 variants: TestConversationVariant[];
 data: ConversationDataEntry[];
}
export interface TestConversationSnapshot extends ConversationSummary {
 messages: TestConversationMessage[];
 data: ConversationDataEntry[];
}
// @approved
// Tests inspect every sibling Variant's raw data and all Message-scoped data.
// The fixture reads these rows alongside the selected path's author stamps.
export function readTestConversationSnapshot(database: Database, conversationId: number): TestConversationSnapshot | undefined {
 const summary = readConversationSummary(database, conversationId);
 if (summary === undefined) return undefined;
 const db = drizzle(database);
 const messages = db.select().from(messageTable).where(eq(messageTable.conversation_id, conversationId))
  .orderBy(asc(messageTable.position)).all();
 const variants = db.select({ ...getTableColumns(messageVariantTable), content: liveVariantContent }).from(messageVariantTable)
  .innerJoin(messageTable, eq(messageTable.id, messageVariantTable.message_id)).where(eq(messageTable.conversation_id, conversationId))
  .orderBy(asc(messageVariantTable.position)).all();
 const messageData = db.select(getTableColumns(messageDataTable)).from(messageDataTable)
  .innerJoin(messageTable, eq(messageTable.id, messageDataTable.message_id)).where(eq(messageTable.conversation_id, conversationId))
  .orderBy(asc(messageDataTable.namespace), asc(messageDataTable.key)).all();
 const variantsByMessage = Map.groupBy(variants, (variant) => variant.message_id);
 const variantData = loadVariantDataRows(db, variants.map((variant) => variant.id));
 const messageDataByMessage = Map.groupBy(messageData, (row) => row.message_id);
 const path = new Map(readSelectedHistory(database, conversationId)!.messages.map((message) => [message.id, message]));
 return {
  ...summary,
  data: readConversationData(database, conversationId)!.entries,
  messages: messages.map((message) => {
   const identity = path.get(message.id)!;
   return {
    id: message.id, position: message.position, timestamp: message.timestamp,
    author: identity.author, historicalContext: identity.historicalContext,
    swipe: deriveMessageSwipeEligibility(summary.playable, identity.historicalContext, summary.cast.map((participant) => participant.id)),
    data: (messageDataByMessage.get(message.id) ?? []).map(toDataEntry),
    variants: (variantsByMessage.get(message.id) ?? []).map((variant) => ({
     id: variant.id, position: variant.position, content: variant.content,
     timestamp: variant.timestamp, selected: variant.selected,
     data: variantData.get(variant.id) ?? [],
    })),
   };
  }),
 };
}
export function createConversationWithHistory(database: Database, input: ConversationCreationInput): TestConversationSnapshot {
 const conversation = createConversation(database, input);
 return requireSnapshot(database, conversation.id);
}

/** @approved A new Chat holds only the Author Note and Memory; suites insert any other Box they exercise. */
export function insertBox(database: Database, conversationId: number, box: BoxId): string {
	const instance = boxInstanceEntry(box);
	for (const entry of [boxStateEntry(box, true), instance]) database.query("INSERT INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, ?, ?, ?)").run(conversationId, entry.namespace, entry.key, entry.value);
	installBoxBlocks(drizzle(database), conversationId, [box]);
	return instance.value;
}

/** @approved Sets a Box's state through the ordinary Conversation command, so an observed database delivers its Memory change. */
export function setBoxState(database: Database, conversationId: number, box: BoxId, state: BoxState): void {
	executeConversationCommand(database, { conversationId, expectedRevision: readConversationSummary(database, conversationId)!.revision, action: { type: "set-box-state", box, state } });
}

/** @approved A Generation's first checkpoint: both streams from their start. */
export const checkpointFromStart = (
	database: Database,
	input: { conversationId: number; generationId: number; content: string; reasoning?: string; latestEventId?: number },
): void => checkpointConversationGeneration(database, {
	conversationId: input.conversationId,
	generationId: input.generationId,
	contentOffset: 0,
	contentDelta: input.content,
	reasoningOffset: 0,
	reasoningDelta: input.reasoning ?? "",
	latestEventId: input.latestEventId ?? 1,
});
