import type { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	connectionProfileDiscoveryModelTable,
	connectionProfilePinnedModelTable,
	connectionProfileTable,
	connectionSecretTable,
	connectionSettingsTable,
} from "../database/schema";
import {
	decryptConnectionSecretSync,
	encryptConnectionSecretSync,
} from "../connection-secrets";
import type {
	ConnectionProfile,
	ConnectionProfileDraft,
	ConnectionProfileSecretSnapshot,
} from "./types";
import {
	ConnectionProfileNameConflictError,
	ConnectionProfileNotFoundError,
} from "./errors";
import {
	normalizeDiscoveryCatalog,
} from "./validation";

export const SETTINGS_ROW_ID = 1;
export type ConnectionSettingsDb = ReturnType<typeof drizzle>;
export type ConnectionProfileRow = typeof connectionProfileTable.$inferSelect;

export function connect(database: Database): ConnectionSettingsDb {
	return drizzle(database);
}

export function ensureSettingsRow(db: ConnectionSettingsDb) {
	db.insert(connectionSettingsTable)
		.values({ id: SETTINGS_ROW_ID, revision: 0 })
		.onConflictDoNothing()
		.run();
	const row = db
		.select()
		.from(connectionSettingsTable)
		.where(eq(connectionSettingsTable.id, SETTINGS_ROW_ID))
		.get();
	if (row === undefined) throw new Error("Connection Settings row is unavailable.");
	return row;
}

export function readProfile(
	db: ConnectionSettingsDb,
	row: ConnectionProfileRow,
	masterKey: Uint8Array,
): ConnectionProfile {
	const pins = db
		.select({ modelId: connectionProfilePinnedModelTable.model_id })
		.from(connectionProfilePinnedModelTable)
		.where(eq(connectionProfilePinnedModelTable.profile_id, row.id))
		.orderBy(asc(connectionProfilePinnedModelTable.position))
		.all()
		.map((pin) => pin.modelId);
	const discoveryCatalog = db
		.select({ modelId: connectionProfileDiscoveryModelTable.model_id })
		.from(connectionProfileDiscoveryModelTable)
		.where(eq(connectionProfileDiscoveryModelTable.profile_id, row.id))
		.all()
		.map((model) => model.modelId);
	let credentialConfigured = false;
	const headers: Array<{ name: string; configured: boolean }> = [];
	const payload = readSecret(db, row.id, masterKey);
	if (payload !== null) {
		credentialConfigured = payload.credential !== null;
		for (const name of Object.keys(payload.headers).sort((a, b) =>
			a.localeCompare(b, undefined, { sensitivity: "base" }),
		)) {
			headers.push({ name, configured: true });
		}
	}
	return {
		id: row.id,
		displayName: row.display_name,
		// ==[HUMAN APPROVED]== SAFETY: these fields are validated by validateConnectionProfileDraft before
		// they are inserted; the assertions restore the closed domain vocabulary on read.
		apiFormat: row.api_format as ConnectionProfile["apiFormat"],
		requestUrl: row.request_url,
		modelsUrl: row.models_url,
		// ==[HUMAN APPROVED]== SAFETY: validateConnectionProfileDraft rejects every Model Backend value
		// outside the closed v1 vocabulary before the row can be written.
		modelBackend: row.model_backend as ConnectionProfile["modelBackend"],
		// ==[HUMAN APPROVED]== SAFETY: validateConnectionProfileDraft rejects every Adapter value outside
		// the three bundled adapter identifiers before the row can be written.
		adapter: row.adapter as ConnectionProfile["adapter"],
		// ==[HUMAN APPROVED]== SAFETY: validateConnectionProfileDraft rejects every output-token
		// representation outside the Chat Completions v1 vocabulary.
		outputTokenRepresentation: row.output_token_representation as ConnectionProfile["outputTokenRepresentation"],
		timeoutMs: row.timeout_ms,
		pinnedModels: pins,
		discoveryCatalog: normalizeDiscoveryCatalog(discoveryCatalog),
		credentialConfigured,
		headers,
	};
}

export function readSecret(
	db: ConnectionSettingsDb,
	profileId: number,
	masterKey: Uint8Array,
): ConnectionProfileSecretSnapshot | null {
	const secret = db
		.select()
		.from(connectionSecretTable)
		.where(eq(connectionSecretTable.profile_id, profileId))
		.get();
	if (secret === undefined) return null;
	const payload = decryptConnectionSecretSync(masterKey, profileId, {
		// ==[HUMAN APPROVED]== SAFETY: the encryption module accepts the versioned value and rejects any
		// unsupported value before decrypting it.
		formatVersion: secret.format_version as 1,
		keyId: secret.key_id,
		nonce: secret.nonce,
		ciphertext: secret.ciphertext,
		tag: secret.tag,
	});
	return {
		credential: payload.credential,
		headers: { ...payload.headers },
	};
}

export function toProfileRow(profile: ConnectionProfileDraft) {
	return {
		display_name: profile.displayName,
		api_format: profile.apiFormat,
		request_url: profile.requestUrl,
		models_url: profile.modelsUrl,
		model_backend: profile.modelBackend,
		adapter: profile.adapter,
		output_token_representation: profile.outputTokenRepresentation,
		timeout_ms: profile.timeoutMs,
	};
}

export function writePinnedModels(
	db: ConnectionSettingsDb,
	profileId: number,
	models: readonly string[],
): void {
	db.delete(connectionProfilePinnedModelTable)
		.where(eq(connectionProfilePinnedModelTable.profile_id, profileId))
		.run();
	if (models.length === 0) return;
	db.insert(connectionProfilePinnedModelTable)
		.values(
			models.map((modelId, index) => ({
				profile_id: profileId,
				position: index + 1,
				model_id: modelId,
			})),
		)
		.run();
}

export function writeSecretState(
	db: ConnectionSettingsDb,
	profileId: number,
	payload: ConnectionProfileSecretSnapshot,
	masterKey: Uint8Array,
): void {
	if (payload.credential === null && Object.keys(payload.headers).length === 0) {
		db.delete(connectionSecretTable)
			.where(eq(connectionSecretTable.profile_id, profileId))
			.run();
		return;
	}
	const encrypted = encryptConnectionSecretSync(masterKey, profileId, {
		credential: payload.credential,
		headers: { ...payload.headers },
	});
	db.insert(connectionSecretTable)
		.values({
			profile_id: profileId,
			format_version: encrypted.formatVersion,
			key_id: encrypted.keyId,
			nonce: encrypted.nonce,
			ciphertext: encrypted.ciphertext,
		tag: encrypted.tag,
		})
		.onConflictDoUpdate({
			target: connectionSecretTable.profile_id,
			set: {
				format_version: encrypted.formatVersion,
				key_id: encrypted.keyId,
				nonce: encrypted.nonce,
				ciphertext: encrypted.ciphertext,
				tag: encrypted.tag,
			},
		})
		.run();
}

export function ensureProfileNameAvailable(
	db: ConnectionSettingsDb,
	displayName: string,
	excludedProfileId?: number,
): void {
	const normalized = displayName.toLowerCase();
	const conflict = db
		.select({ id: connectionProfileTable.id, displayName: connectionProfileTable.display_name })
		.from(connectionProfileTable)
		.all()
		.some((profile) =>
			profile.id !== excludedProfileId && profile.displayName.toLowerCase() === normalized,
		);
	if (conflict) throw new ConnectionProfileNameConflictError(displayName);
}

export function requireProfile(
	db: ConnectionSettingsDb,
	profileId: number,
	): ConnectionProfileRow {
	const profile = db
		.select()
		.from(connectionProfileTable)
		.where(eq(connectionProfileTable.id, profileId))
		.get();
	if (profile === undefined) throw new ConnectionProfileNotFoundError(profileId);
	return profile;
}

// ==[HUMAN APPROVED]== The one revision advance: every successful revisioned write bumps the
// revision exactly once. The revisionedWrite seam is its sole caller, so "every
// write bumps exactly once" is a property of the seam, not of caller
// discipline.
export function advanceRevision(
	db: ConnectionSettingsDb,
	revision: number,
): void {
	db.update(connectionSettingsTable)
		.set({ revision: revision + 1 })
		.where(eq(connectionSettingsTable.id, SETTINGS_ROW_ID))
		.run();
}
