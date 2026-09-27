import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { connectionProfileTable, memorySecretTable, memorySettingsTable } from "../database/schema";
import { decryptConnectionSecretSync, encryptConnectionSecretSync, getConnectionSecretKey } from "../connection-secrets";
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
export interface MemorySettingsModuleOptions { readonly masterKey?: Uint8Array }

export const createMemorySettingsModule = (database: Database, options: MemorySettingsModuleOptions = {}) => {
	const db = drizzle(database);
	const key = () => options.masterKey === undefined ? getConnectionSecretKey() : new Uint8Array(options.masterKey);
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
			extractionProfileId: value.extraction_profile_id,
			extractionModel: value.extraction_model,
			contextLimit: value.context_limit,
			outputReserve: value.output_reserve,
			safetyAllowance: value.safety_allowance,
			jevModel: value.jev_model,
			usefulnessConfidenceGate: value.usefulness_confidence_gate,
			credentialConfigured: db.select({ id: memorySecretTable.id }).from(memorySecretTable).where(eq(memorySecretTable.id, SETTINGS_ID)).get() !== undefined,
		};
	};
	const getCredential = (): string | null => {
		const value = db.select().from(memorySecretTable).where(eq(memorySecretTable.id, SETTINGS_ID)).get();
		if (!value) return null;
		return decryptConnectionSecretSync(key(), SETTINGS_ID, {
			// ==[HUMAN APPROVED]== SAFETY: This module's encrypted-secret writer stores version 1, and decryption rejects unsupported versions.
			formatVersion: value.format_version as 1, keyId: value.key_id, nonce: value.nonce,
			ciphertext: value.ciphertext, tag: value.tag,
		}).credential;
	};
	const writeSecret = (connection: Db, credential: string | null) => {
		if (credential === null || credential.trim().length === 0) {
			connection.delete(memorySecretTable).where(eq(memorySecretTable.id, SETTINGS_ID)).run();
			return;
		}
		const secret = encryptConnectionSecretSync(key(), SETTINGS_ID, { credential, headers: {} });
		connection.insert(memorySecretTable).values({ id: SETTINGS_ID, format_version: secret.formatVersion, key_id: secret.keyId, nonce: secret.nonce, ciphertext: secret.ciphertext, tag: secret.tag }).onConflictDoUpdate({
			target: memorySecretTable.id,
			set: { format_version: secret.formatVersion, key_id: secret.keyId, nonce: secret.nonce, ciphertext: secret.ciphertext, tag: secret.tag },
		}).run();
	};
	const commit = (expectedRevision: number, mutate: (connection: Db, current: typeof memorySettingsTable.$inferSelect) => void) => database.transaction(() => {
		const current = row();
		if (current.revision !== expectedRevision) throw new StaleMemorySettingsError(expectedRevision, current.revision, get());
		mutate(db, current);
		db.update(memorySettingsTable).set({ revision: current.revision + 1 }).where(eq(memorySettingsTable.id, SETTINGS_ID)).run();
		return get();
	}).immediate();
	const apply = (command: Extract<MemorySettingsCommand, { type: "apply" }>) => {
		const model = command.extractionModel.trim();
		const jevModel = command.jevModel.trim();
		if (command.extractionProfileId !== null && db.select({ id: connectionProfileTable.id }).from(connectionProfileTable).where(eq(connectionProfileTable.id, command.extractionProfileId)).get() === undefined) {
			throw new InvalidMemorySettingsError("The selected extraction Connection Profile no longer exists. Choose an available profile.");
		}
		if (command.extractionProfileId !== null && model.length === 0) throw new InvalidMemorySettingsError("Choose an extraction model for the selected Connection Profile.");
		if (command.extractionProfileId === null && model.length > 0) throw new InvalidMemorySettingsError("Choose a Connection Profile before setting an extraction model.");
		if (![command.contextLimit, command.outputReserve].every((limit) => Number.isSafeInteger(limit) && limit > 0 && limit <= 1_000_000)) throw new InvalidMemorySettingsError("Extraction context and output limits must be positive whole numbers no greater than 1,000,000.");
		if (!Number.isSafeInteger(command.safetyAllowance) || command.safetyAllowance < 0 || command.safetyAllowance > 1_000_000) throw new InvalidMemorySettingsError("The safety allowance must be a non-negative whole number no greater than 1,000,000.");
		if (!jevModel) throw new InvalidMemorySettingsError("Choose a Typesafe Jev model.");
		if (!(command.usefulnessConfidenceGate >= 0 && command.usefulnessConfidenceGate <= 1)) throw new InvalidMemorySettingsError("The usefulness confidence gate must be between 0 and 1.");
		return commit(command.expectedRevision, (connection) => {
			connection.update(memorySettingsTable).set({ extraction_profile_id: command.extractionProfileId, extraction_model: model, context_limit: command.contextLimit, output_reserve: command.outputReserve, safety_allowance: command.safetyAllowance, jev_model: jevModel, usefulness_confidence_gate: command.usefulnessConfidenceGate }).where(eq(memorySettingsTable.id, SETTINGS_ID)).run();
			if (command.credential !== undefined) writeSecret(connection, command.credential);
		});
	};
	const changeCredential = (expectedRevision: number, credential: string | null) => commit(expectedRevision, (connection) => writeSecret(connection, credential));
	return {
		get,
		getCredential,
		apply,
		setCredential: (command: Extract<MemorySettingsCommand, { type: "set-credential" }>) => changeCredential(command.expectedRevision, command.credential),
		resetCredential: (command: Extract<MemorySettingsCommand, { type: "reset-credential" }>) => {
			if (!command.confirmed) throw new InvalidMemorySettingsError("Resetting the Typesafe credential requires confirmation.");
			return changeCredential(command.expectedRevision, null);
		},
	};
};
