import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { boxReference, connectionProfileTable, putLibraryValue, readEmbeddingConfiguration, readLibraryValue } from "@/box-sdk/server";
import { memorySettingsValue, type MemorySettingsCommand, type MemorySettingsPayload, type MemorySettingsValue } from "./contract";
import { InvalidMemoryCommandError, memoryGuard } from "./server-errors";

// @approved
//  Memory's global settings: one library_data value in its own Box namespace.
// Memory runs in a Chat when the Memory Box is enabled there; these settings
// only choose its extraction and embedding models and its thresholds.
const KEY = "settings";
const defaults: MemorySettingsValue = {
	extractionProfileId: null,
	extractionModel: "",
	contextLimit: 16384,
	outputReserve: 2048,
	safetyAllowance: 500,
	retainProbabilityMinimum: 0.6,
	recallRelevanceMinimum: 1.5,
	embeddingProfileId: null,
	embeddingModel: "",
};

export const createMemorySettingsModule = (database: Database) => {
	const db = drizzle(database);
	const get = (): MemorySettingsPayload => readLibraryValue(db, boxReference("memory"), KEY, memorySettingsValue, defaults);
	const checkChoice = (role: "extraction" | "embedding", profileId: number | null, model: string) => {
		if (profileId === null) {
			if (model.length > 0) throw new InvalidMemoryCommandError(`Choose a Connection Profile before setting an ${role} model.`);
			return;
		}
		const profile = db
			.select({ apiFormat: connectionProfileTable.api_format })
			.from(connectionProfileTable)
			.where(eq(connectionProfileTable.id, profileId))
			.get();
		if (profile === undefined) throw new InvalidMemoryCommandError(`The selected ${role} Connection Profile no longer exists. Choose an available profile.`);
		if (profile.apiFormat !== (role === "embedding" ? "embeddings" : "chat-completions")) {
			throw new InvalidMemoryCommandError(role === "embedding" ? "Choose an Embeddings connection for the embedding model." : "Choose a chat connection for the extraction model.");
		}
		if (model.length === 0) throw new InvalidMemoryCommandError(`Choose an ${role} model for the selected Connection Profile.`);
	};
	const apply = (command: MemorySettingsCommand) => database.transaction(() => {
		const model = command.extractionModel.trim();
		const embeddingModel = command.embeddingModel.trim();
		checkChoice("extraction", command.extractionProfileId, model);
		checkChoice("embedding", command.embeddingProfileId, embeddingModel);
		if (![command.contextLimit, command.outputReserve].every((limit) => Number.isSafeInteger(limit) && limit > 0 && limit <= 1_000_000)) {
			throw new InvalidMemoryCommandError("Extraction context and output limits must be positive whole numbers no greater than 1,000,000.");
		}
		if (!Number.isSafeInteger(command.safetyAllowance) || command.safetyAllowance < 0 || command.safetyAllowance > 1_000_000) {
			throw new InvalidMemoryCommandError("The safety allowance must be a non-negative whole number no greater than 1,000,000.");
		}
		if (!(command.retainProbabilityMinimum >= 0 && command.retainProbabilityMinimum <= 1)) throw new InvalidMemoryCommandError("The retain probability minimum must be between 0 and 1.");
		if (!(command.recallRelevanceMinimum >= 0 && command.recallRelevanceMinimum <= 3)) throw new InvalidMemoryCommandError("The recall relevance minimum must be between 0 and 3.");
		const value = Value.Clean(memorySettingsValue, { ...command, extractionModel: model, embeddingModel });
		const { expectedRevision } = command;
		putLibraryValue(db, { namespace: boxReference("memory"), key: KEY, value: JSON.stringify(value) }, memoryGuard(expectedRevision, (actualRevision) => ({ expectedRevision, actualRevision, currentSettings: get() })));
		return get();
	}).immediate();
	return { get, apply };
};

/** @approved The embedding model Memory Settings choose. */
export const readMemoryEmbedding = (database: Database) => {
	const { embeddingProfileId, embeddingModel } = createMemorySettingsModule(database).get();
	return readEmbeddingConfiguration(database, embeddingProfileId, embeddingModel);
};
