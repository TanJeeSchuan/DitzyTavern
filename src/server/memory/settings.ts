import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { connectionProfileTable, conversationPromptPresetTable, memorySettingsTable } from "../database/schema";
import { createRevisionedSettings, InvalidSettingsError } from "../revisioned-settings";
import { readConversationPromptPresetRecipe, readConversationPromptPresetRecipes } from "../prompt-preset";
import { hasEnabledMemorySlot } from "../../shared/contract/prompt-preset";
import { refreshMemoryForConversation } from "./sync";
import type { MemorySettingsCommand, MemorySettingsPayload } from "../../shared/contract/memory-settings";
import { validateDecisionSelection } from "../decision-model";

export const createMemorySettingsModule = (database: Database) => {
	const db = drizzle(database);
	const settings = createRevisionedSettings(database, memorySettingsTable, (value): MemorySettingsPayload => ({
		revision: value.revision,
		enabled: value.enabled,
		extractionProfileId: value.extraction_profile_id,
		extractionModel: value.extraction_model,
		contextLimit: value.context_limit,
		outputReserve: value.output_reserve,
		safetyAllowance: value.safety_allowance,
		retainProbabilityMinimum: value.retain_probability_minimum,
		decisionProfileId: value.decision_profile_id,
		decisionModel: value.decision_model,
		decisionStateTokenLimit: value.decision_state_token_limit,
		recallRelevanceMinimum: value.recall_relevance_minimum,
		embeddingProfileId: value.embedding_profile_id,
		embeddingModel: value.embedding_model,
	}));
	const checkChoice = (role: "extraction" | "embedding", profileId: number | null, model: string) => {
		if (profileId === null) {
			if (model.length > 0) throw new InvalidSettingsError(`Choose a Connection Profile before setting an ${role} model.`);
			return;
		}
		const profile = db
			.select({ apiFormat: connectionProfileTable.api_format })
			.from(connectionProfileTable)
			.where(eq(connectionProfileTable.id, profileId))
			.get();
		if (profile === undefined) throw new InvalidSettingsError(`The selected ${role} Connection Profile no longer exists. Choose an available profile.`);
		if (profile.apiFormat !== (role === "embedding" ? "embeddings" : "chat-completions")) {
			throw new InvalidSettingsError(role === "embedding" ? "Choose an Embeddings connection for the embedding model." : "Choose a chat connection for the extraction model.");
		}
		if (model.length === 0) throw new InvalidSettingsError(`Choose an ${role} model for the selected Connection Profile.`);
	};
	const apply = (command: MemorySettingsCommand) => database.transaction(() => {
		const model = command.extractionModel.trim();
		const embeddingModel = command.embeddingModel.trim();
		checkChoice("extraction", command.extractionProfileId, model);
		checkChoice("embedding", command.embeddingProfileId, embeddingModel);
		validateDecisionSelection(database, command);
		if (![command.contextLimit, command.outputReserve].every((limit) => Number.isSafeInteger(limit) && limit > 0 && limit <= 1_000_000)) {
			throw new InvalidSettingsError("Extraction context and output limits must be positive whole numbers no greater than 1,000,000.");
		}
		if (!Number.isSafeInteger(command.safetyAllowance) || command.safetyAllowance < 0 || command.safetyAllowance > 1_000_000) {
			throw new InvalidSettingsError("The safety allowance must be a non-negative whole number no greater than 1,000,000.");
		}
		if (!(command.retainProbabilityMinimum >= 0 && command.retainProbabilityMinimum <= 1)) throw new InvalidSettingsError("The retain probability minimum must be between 0 and 1.");
		if (!(command.recallRelevanceMinimum >= 0 && command.recallRelevanceMinimum <= 3)) throw new InvalidSettingsError("The recall relevance minimum must be between 0 and 3.");
		const toggled = settings.get().enabled !== command.enabled;
		const applied = settings.commit(command.expectedRevision, {
			enabled: command.enabled,
			extraction_profile_id: command.extractionProfileId,
			extraction_model: model,
			context_limit: command.contextLimit,
			output_reserve: command.outputReserve,
			safety_allowance: command.safetyAllowance,
			retain_probability_minimum: command.retainProbabilityMinimum,
			decision_profile_id: command.decisionProfileId,
			decision_model: command.decisionModel.trim(),
			decision_state_token_limit: command.decisionStateTokenLimit,
			recall_relevance_minimum: command.recallRelevanceMinimum,
			embedding_profile_id: command.embeddingProfileId,
			embedding_model: embeddingModel,
		});
		if (toggled) {
			const conversations = db.select({ id: conversationPromptPresetTable.conversation_id }).from(conversationPromptPresetTable).all();
			for (const { id } of conversations) {
				refreshMemoryForConversation(database, id, "Memory was turned off. Reset and re-extract this source to try again.");
			}
		}
		return applied;
	}).immediate();
	return { get: settings.get, apply };
};

export const isMemoryEnabledForConversation = (database: Database, conversationId: number): boolean => {
	if (!createMemorySettingsModule(database).get().enabled) return false;
	const recipe = readConversationPromptPresetRecipe(database, conversationId);
	return recipe !== undefined && hasEnabledMemorySlot(recipe.slots);
};

/** @approved
 * The same per-Conversation rule as `isMemoryEnabledForConversation`, decided
 * once for a set of Conversations. Index claiming reads this set instead of
 * re-reading a recipe per candidate.
 */
export const readMemoryEnabledConversationIds = (database: Database, conversationIds: readonly number[]): Set<number> => {
	if (!createMemorySettingsModule(database).get().enabled) return new Set();
	return new Set(
		[...readConversationPromptPresetRecipes(database, conversationIds)]
			.filter(([, recipe]) => hasEnabledMemorySlot(recipe.slots))
			.map(([conversationId]) => conversationId),
	);
};
