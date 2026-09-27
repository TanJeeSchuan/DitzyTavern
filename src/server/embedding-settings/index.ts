import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	embeddingSecretTable,
	embeddingSettingsTable,
} from "../database/schema";
import {
	decryptConnectionSecretSync,
	encryptConnectionSecretSync,
	getConnectionSecretKey,
} from "../connection-secrets";
import type {
	EmbeddingSettingsCommand,
	EmbeddingSettingsPayload,
} from "../../shared/contract/embedding-settings";

const SETTINGS_ID = 1;

export class InvalidEmbeddingSettingsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InvalidEmbeddingSettingsError";
	}
}

export class StaleEmbeddingSettingsError extends Error {
	constructor(
		readonly expectedRevision: number,
		readonly actualRevision: number,
		readonly currentSettings: EmbeddingSettingsPayload,
	) {
		super(`Expected Embedding Settings revision ${expectedRevision}, but the current revision is ${actualRevision}.`);
		this.name = "StaleEmbeddingSettingsError";
	}
}

export interface EmbeddingSettingsModuleOptions {
	readonly masterKey?: Uint8Array;
}

export interface EmbeddingSettingsModule {
	get(): EmbeddingSettingsPayload;
	getCredential(): string | null;
	apply(command: Extract<EmbeddingSettingsCommand, { type: "apply" }>): EmbeddingSettingsPayload;
	setCredential(command: Extract<EmbeddingSettingsCommand, { type: "set-credential" }>): EmbeddingSettingsPayload;
	resetCredential(command: Extract<EmbeddingSettingsCommand, { type: "reset-credential" }>): EmbeddingSettingsPayload;
}

type Db = ReturnType<typeof drizzle>;

const connect = (database: Database): Db => drizzle(database);

const normalizeEndpoint = (value: string): string => {
	const endpoint = value.trim();
	if (endpoint.length === 0) return "";
	let url: URL;
	try { url = new URL(endpoint); } catch { throw new InvalidEmbeddingSettingsError("The embedding endpoint must be a valid HTTP or HTTPS URL."); }
	if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash) {
		throw new InvalidEmbeddingSettingsError("The embedding endpoint must use HTTP or HTTPS without user information or a fragment.");
	}
	return endpoint;
};

const normalize = (input: { endpoint: string; model: string; deadlineMs: number }) => {
	const endpoint = normalizeEndpoint(input.endpoint);
	const model = input.model.trim();
	if (endpoint.length === 0) {
		if (model.length > 0) throw new InvalidEmbeddingSettingsError("An embedding endpoint is required when a model is configured.");
	} else if (model.length === 0) {
		throw new InvalidEmbeddingSettingsError("An embedding model is required when an endpoint is configured.");
	}
	if (!Number.isInteger(input.deadlineMs) || input.deadlineMs < 1) {
		throw new InvalidEmbeddingSettingsError("The embedding deadline must be a positive whole number of milliseconds.");
	}
	return { endpoint, model, deadlineMs: input.deadlineMs };
};

export function createEmbeddingSettingsModule(
	database: Database,
	options: EmbeddingSettingsModuleOptions = {},
): EmbeddingSettingsModule {
	const getKey = () => options.masterKey === undefined ? getConnectionSecretKey() : new Uint8Array(options.masterKey);
	const ensure = (db: Db) => {
		db.insert(embeddingSettingsTable).values({ id: SETTINGS_ID }).onConflictDoNothing().run();
		const row = db.select().from(embeddingSettingsTable).where(eq(embeddingSettingsTable.id, SETTINGS_ID)).get();
		if (row === undefined) throw new Error("Embedding Settings row is unavailable.");
		return row;
	};
	const read = (): EmbeddingSettingsPayload => {
		const db = connect(database);
		const row = ensure(db);
		return {
			revision: row.revision,
			endpoint: row.endpoint,
			model: row.model,
			deadlineMs: row.deadline_ms,
			credentialConfigured: db.select({ id: embeddingSecretTable.settings_id }).from(embeddingSecretTable).where(eq(embeddingSecretTable.settings_id, SETTINGS_ID)).get() !== undefined,
		};
	};
	const credential = (): string | null => {
		const db = connect(database);
		const row = db.select().from(embeddingSecretTable).where(eq(embeddingSecretTable.settings_id, SETTINGS_ID)).get();
		if (row === undefined) return null;
		return decryptConnectionSecretSync(getKey(), SETTINGS_ID, {
			// ==[HUMAN APPROVED]== SAFETY: the encrypted-secret writer stores only the supported format version.
			formatVersion: row.format_version as 1,
			keyId: row.key_id,
			nonce: row.nonce,
			ciphertext: row.ciphertext,
			tag: row.tag,
		}).credential;
	};
	const writeSecret = (db: Db, value: string | null) => {
		if (value === null || value.trim().length === 0) {
			db.delete(embeddingSecretTable).where(eq(embeddingSecretTable.settings_id, SETTINGS_ID)).run();
			return;
		}
		const encrypted = encryptConnectionSecretSync(getKey(), SETTINGS_ID, { credential: value, headers: {} });
		db.insert(embeddingSecretTable).values({
			settings_id: SETTINGS_ID,
			format_version: encrypted.formatVersion,
			key_id: encrypted.keyId,
			nonce: encrypted.nonce,
			ciphertext: encrypted.ciphertext,
			tag: encrypted.tag,
		}).onConflictDoUpdate({
			target: embeddingSecretTable.settings_id,
			set: {
				format_version: encrypted.formatVersion,
				key_id: encrypted.keyId,
				nonce: encrypted.nonce,
				ciphertext: encrypted.ciphertext,
				tag: encrypted.tag,
			},
		}).run();
	};
	const write = (expectedRevision: number, mutate: (db: Db, row: typeof embeddingSettingsTable.$inferSelect) => void) => {
		const result = database.transaction(() => {
			const db = connect(database);
			const row = ensure(db);
			if (row.revision !== expectedRevision) throw new StaleEmbeddingSettingsError(expectedRevision, row.revision, read());
			mutate(db, row);
			db.update(embeddingSettingsTable).set({ revision: row.revision + 1 }).where(eq(embeddingSettingsTable.id, SETTINGS_ID)).run();
			return read();
		}).immediate();
		return result;
	};
	return {
		get: read,
		getCredential: credential,
		apply: (command) => {
			const values = normalize(command);
			return write(command.expectedRevision, (db) => {
				db.update(embeddingSettingsTable).set({ endpoint: values.endpoint, model: values.model, deadline_ms: values.deadlineMs }).where(eq(embeddingSettingsTable.id, SETTINGS_ID)).run();
				if (command.credential !== undefined) writeSecret(db, command.credential);
			});
		},
		setCredential: (command) => write(command.expectedRevision, (db) => writeSecret(db, command.credential)),
		resetCredential: (command) => {
			if (!command.confirmed) throw new InvalidEmbeddingSettingsError("Resetting the embedding credential requires confirmation.");
			return write(command.expectedRevision, (db) => writeSecret(db, null));
		},
	};
}

export { normalizeEndpoint as validateEmbeddingEndpoint };
