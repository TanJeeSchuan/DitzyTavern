import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { connectionProfileTable, conversationPromptPresetTable, memorySettingsTable } from "../database/schema";
import { refreshMemoryForConversation } from "./sync";
import type { MemorySettingsCommand, MemorySettingsPayload } from "../../shared/contract/memory-settings";

const SETTINGS_ID = 1;
type Db = ReturnType<typeof drizzle>;

export class InvalidMemorySettingsError extends Error {
	constructor(message: string) { super(message); this.name = "InvalidMemorySettingsError"; }
}
export class StaleMemorySettingsError extends Error {
	constructor(readonly expectedRevision: number, readonly actualRevision: number, readonly currentSettings: MemorySettingsPayload) {
		super(`Expected Memory Settings revision ${expectedRevision}, but the current revision is ${actualRevision}.`);
		this.name = "StaleMemorySettingsError";
	}
}
export const createMemorySettingsModule = (database: Database) => {
	const db = drizzle(database);
	const row = (connection: Db = db) => {
		connection.insert(memorySettingsTable).values({ id: SETTINGS_ID }).onConflictDoNothing().run();
		const value = connection.select().from(memorySettingsTable).where(eq(memorySettingsTable.id, SETTINGS_ID)).get();
		if (!value) throw new Error("Memory Settings are unavailable.");
		return value;
	};
	const get = (): MemorySettingsPayload => {
		const value = row();
		return {
			revision: value.revision,
			enabled: value.enabled,
			extractionProfileId: value.extraction_profile_id,
			extractionModel: value.extraction_model,
			contextLimit: value.context_limit,
			outputReserve: value.output_reserve,
			safetyAllowance: value.safety_allowance,
			usefulnessConfidenceGate: value.usefulness_confidence_gate,
			recallRelevanceMinimum: value.recall_relevance_minimum,
			embeddingProfileId: value.embedding_profile_id,
			embeddingModel: value.embedding_model,
		};
	};
	const commit = (expectedRevision: number, mutate: (connection: Db, current: typeof memorySettingsTable.$inferSelect) => void) => database.transaction(() => {
		const current = row();
		if (current.revision !== expectedRevision) throw new StaleMemorySettingsError(expectedRevision, current.revision, get());
		mutate(db, current);
		db.update(memorySettingsTable).set({ revision: current.revision + 1 }).where(eq(memorySettingsTable.id, SETTINGS_ID)).run();
		return get();
	}).immediate();
	const checkChoice = (role: "extraction" | "embedding", profileId: number | null, model: string) => {
		if (profileId === null) {
			if (model.length > 0) throw new InvalidMemorySettingsError(`Choose a Connection Profile before setting an ${role} model.`);
			return;
		}
		const profile = db.select({ apiFormat: connectionProfileTable.api_format }).from(connectionProfileTable).where(eq(connectionProfileTable.id, profileId)).get();
		if (profile === undefined) throw new InvalidMemorySettingsError(`The selected ${role} Connection Profile no longer exists. Choose an available profile.`);
		if ((profile.apiFormat === "embeddings") !== (role === "embedding")) throw new InvalidMemorySettingsError(role === "embedding" ? "Choose an Embeddings connection for the embedding model." : "Choose a chat connection for the extraction model.");
		if (model.length === 0) throw new InvalidMemorySettingsError(`Choose an ${role} model for the selected Connection Profile.`);
	};
	const apply = (command: MemorySettingsCommand) => database.transaction(() => {
		const model = command.extractionModel.trim();
		const embeddingModel = command.embeddingModel.trim();
		checkChoice("extraction", command.extractionProfileId, model);
		checkChoice("embedding", command.embeddingProfileId, embeddingModel);
		if (![command.contextLimit, command.outputReserve].every((limit) => Number.isSafeInteger(limit) && limit > 0 && limit <= 1_000_000)) throw new InvalidMemorySettingsError("Extraction context and output limits must be positive whole numbers no greater than 1,000,000.");
		if (!Number.isSafeInteger(command.safetyAllowance) || command.safetyAllowance < 0 || command.safetyAllowance > 1_000_000) throw new InvalidMemorySettingsError("The safety allowance must be a non-negative whole number no greater than 1,000,000.");
		if (!(command.usefulnessConfidenceGate >= 0 && command.usefulnessConfidenceGate <= 1)) throw new InvalidMemorySettingsError("The usefulness confidence gate must be between 0 and 1.");
		if (!(command.recallRelevanceMinimum >= 0 && command.recallRelevanceMinimum <= 3)) throw new InvalidMemorySettingsError("The recall relevance minimum must be between 0 and 3.");
		const toggled = get().enabled !== command.enabled;
		const settings = commit(command.expectedRevision, (connection) => {
			connection.update(memorySettingsTable).set({ enabled: command.enabled, extraction_profile_id: command.extractionProfileId, extraction_model: model, context_limit: command.contextLimit, output_reserve: command.outputReserve, safety_allowance: command.safetyAllowance, usefulness_confidence_gate: command.usefulnessConfidenceGate, recall_relevance_minimum: command.recallRelevanceMinimum, embedding_profile_id: command.embeddingProfileId, embedding_model: embeddingModel }).where(eq(memorySettingsTable.id, SETTINGS_ID)).run();
		});
		if (toggled) for (const { id } of db.select({ id: conversationPromptPresetTable.conversation_id }).from(conversationPromptPresetTable).all()) refreshMemoryForConversation(database, id, "Memory was turned off. Reset and re-extract this source to try again.");
		return settings;
	}).immediate();
	return { get, apply };
};

export const isMemoryEnabledForConversation = (database: Database, conversationId: number): boolean =>
	createMemorySettingsModule(database).get().enabled && database.query<{ enabled: number }, [number]>("SELECT 1 AS enabled FROM conversation_prompt_preset p JOIN prompt_preset_block b ON b.preset_id = p.prompt_preset_id WHERE p.conversation_id = ? AND b.reference = 'memory' AND b.enabled = 1").get(conversationId) !== null;
