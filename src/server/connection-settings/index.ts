import type { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import {
	connectionProfileDiscoveryModelTable,
	connectionProfileTable,
	connectionSecretTable,
	connectionSettingsTable,
} from "../database/schema";
import {
	getConnectionSecretKey,
} from "../connection-secrets";
import {
	ConnectionCredentialConfirmationError,
	ConnectionProfileNameConflictError,
	ConnectionProfileNotFoundError,
	ConnectionProfileReplacementRequiredError,
	InvalidConnectionProfileError,
	StaleConnectionSettingsRevisionError,
} from "./errors";
import {
	cloneProfileDraft,
	listConnectionPresets,
} from "./presets";
import {
	advanceRevision,
	connect,
	ensureProfileNameAvailable,
	ensureSettingsRow,
	readProfile,
	readSecret,
	requireProfile,
	SETTINGS_ROW_ID,
	toProfileRow,
	writePinnedModels,
	writeSecretState,
} from "./persistence";
import {
	applyConnectionHeaderOperations,
	applyHeaderOperations,
	normalizeCredential,
	normalizeDiscoveryCatalog,
	normalizePinnedModels,
	validateConnectionProfileDraft,
	validateHeaderOperations,
} from "./validation";
import type {
	ApplyConnectionProfileInput,
	ActivateConnectionProfileInput,
	ConnectionProfileSecretSnapshot,
	ConnectionSettingsModule,
	ConnectionSettingsSnapshot,
	CreateConnectionProfileInput,
	DeleteConnectionProfileInput,
	SetPinnedModelsInput,
	ResetConnectionCredentialInput,
	SetConnectionCredentialInput,
} from "./types";

export interface ConnectionSettingsModuleOptions {
	readonly masterKey?: Uint8Array;
}

export function createConnectionSettingsModule(
	database: Database,
	options: ConnectionSettingsModuleOptions = {},
): ConnectionSettingsModule {
	const masterKey = options.masterKey === undefined
		? undefined
		: new Uint8Array(options.masterKey);

	const getKey = () => masterKey ?? getConnectionSecretKey();

	const read = (): ConnectionSettingsSnapshot => {
		const db = connect(database);
		const settings = ensureSettingsRow(db);
		const profiles = db
			.select()
			.from(connectionProfileTable)
			.orderBy(asc(connectionProfileTable.id))
			.all()
			.map((profile) => readProfile(db, profile, getKey()));
		const activeProfileId = settings.active_profile_id;
		if (profiles.length === 0 && activeProfileId !== null) {
			throw new Error("Connection Settings active Profile invariant is broken.");
		}
		if (
			activeProfileId !== null &&
			!profiles.some((profile) => profile.id === activeProfileId)
		) {
			throw new Error("Connection Settings active Profile invariant is broken.");
		}
		if (profiles.length > 0 && activeProfileId === null) {
			throw new Error("Connection Settings active Profile invariant is broken.");
		}
		return {
			revision: settings.revision,
			activeProfileId,
			profiles,
		};
	};

	const getProfileSecrets = (profileId: number): ConnectionProfileSecretSnapshot | null => {
		const db = connect(database);
		const profile = requireProfile(db, profileId);
		const secret = readSecret(db, profile.id, getKey());
		if (secret === null) return null;
		return {
			credential: secret.credential,
			headers: { ...secret.headers },
		};
	};

	const createProfile = (input: CreateConnectionProfileInput) => {
		const profile = validateConnectionProfileDraft(input.profile);
		const credential = normalizeCredential(input.credential);
		const headerOperations = validateHeaderOperations(input.headers ?? []);
		const create = database.transaction(() => {
			const db = connect(database);
			const settings = ensureSettingsRow(db);
			requireRevision(database, settings.revision, input.expectedRevision, getKey());
			ensureProfileNameAvailable(db, profile.displayName);

			const inserted = db
				.insert(connectionProfileTable)
				.values(toProfileRow(profile))
				.returning({ id: connectionProfileTable.id })
				.get();
			if (inserted === undefined) {
				throw new Error("Connection Profile creation did not return an identifier.");
			}

			writePinnedModels(db, inserted.id, profile.pinnedModels);
			writeSecretState(db, inserted.id, {
				credential,
				headers: applyHeaderOperations({}, headerOperations),
			}, getKey());

			db.update(connectionSettingsTable)
				.set({
					revision: settings.revision + 1,
					active_profile_id: settings.active_profile_id ?? inserted.id,
				})
				.where(eq(connectionSettingsTable.id, SETTINGS_ROW_ID))
				.run();
			return read();
		});
		return create.immediate();
	};

	const applyProfile = (input: ApplyConnectionProfileInput) => {
		const profile = validateConnectionProfileDraft(input.profile);
		const headerOperations = validateHeaderOperations(input.headers ?? []);
		const apply = database.transaction(() => {
			const db = connect(database);
			const settings = ensureSettingsRow(db);
			requireRevision(database, settings.revision, input.expectedRevision, getKey());
			const current = db
				.select()
				.from(connectionProfileTable)
				.where(eq(connectionProfileTable.id, input.profileId))
				.get();
			if (current === undefined) {
				throw new ConnectionProfileNotFoundError(input.profileId);
			}
			ensureProfileNameAvailable(db, profile.displayName, input.profileId);
			const currentSecret = readSecret(db, input.profileId, getKey());
			const modelsUrlChanged = current.models_url !== profile.modelsUrl;

			db.update(connectionProfileTable)
				.set(toProfileRow(profile))
				.where(eq(connectionProfileTable.id, input.profileId))
				.run();
			writePinnedModels(db, input.profileId, profile.pinnedModels);
			if (modelsUrlChanged) {
				db.delete(connectionProfileDiscoveryModelTable)
					.where(eq(connectionProfileDiscoveryModelTable.profile_id, input.profileId))
					.run();
			}
			writeSecretState(db, input.profileId, {
				credential: currentSecret?.credential ?? null,
				headers: applyHeaderOperations(currentSecret?.headers ?? {}, headerOperations),
			}, getKey());
			db.update(connectionSettingsTable)
				.set({ revision: settings.revision + 1 })
				.where(eq(connectionSettingsTable.id, SETTINGS_ROW_ID))
				.run();
			return read();
		});
		return apply.immediate();
	};

	const activateProfile = (input: ActivateConnectionProfileInput) => {
		const activate = database.transaction(() => {
			const db = connect(database);
			const settings = ensureSettingsRow(db);
			requireRevision(database, settings.revision, input.expectedRevision, getKey());
			requireProfile(db, input.profileId);

			if (settings.active_profile_id === input.profileId) return read();

			db.update(connectionSettingsTable)
				.set({
					revision: settings.revision + 1,
					active_profile_id: input.profileId,
				})
				.where(eq(connectionSettingsTable.id, SETTINGS_ROW_ID))
				.run();
			return read();
		});
		return activate.immediate();
	};

	const deleteProfile = (input: DeleteConnectionProfileInput) => {
		const remove = database.transaction(() => {
			const db = connect(database);
			const settings = ensureSettingsRow(db);
			requireRevision(database, settings.revision, input.expectedRevision, getKey());
			requireProfile(db, input.profileId);

			const profiles = db
				.select({ id: connectionProfileTable.id })
				.from(connectionProfileTable)
				.orderBy(asc(connectionProfileTable.id))
				.all();
			const deletingActive = settings.active_profile_id === input.profileId;
			let nextActiveProfileId = settings.active_profile_id;
			if (deletingActive && profiles.length > 1) {
				const replacementProfileId = input.replacementProfileId ?? null;
				if (replacementProfileId === null || replacementProfileId === input.profileId) {
					throw new ConnectionProfileReplacementRequiredError();
				}
				requireProfile(db, replacementProfileId);
				nextActiveProfileId = replacementProfileId;
			} else if (deletingActive) {
				nextActiveProfileId = null;
			}

			db.update(connectionSettingsTable)
				.set({
					revision: settings.revision + 1,
					active_profile_id: nextActiveProfileId,
				})
				.where(eq(connectionSettingsTable.id, SETTINGS_ROW_ID))
				.run();
			db.delete(connectionProfileTable)
				.where(eq(connectionProfileTable.id, input.profileId))
				.run();
			return read();
		});
		return remove.immediate();
	};

	const setCredential = (input: SetConnectionCredentialInput) => {
		if (input.credential.trim().length === 0) {
			throw new InvalidConnectionProfileError("A Connection Credential is required.");
		}
		const update = database.transaction(() => {
			const db = connect(database);
			const settings = ensureSettingsRow(db);
			requireRevision(database, settings.revision, input.expectedRevision, getKey());
			requireProfile(db, input.profileId);
			const currentSecret = readSecret(db, input.profileId, getKey());
			writeSecretState(db, input.profileId, {
				credential: input.credential,
				headers: currentSecret?.headers ?? {},
			}, getKey());
			advanceRevision(db, settings.revision);
			return read();
		});
		return update.immediate();
	};

	const setPinnedModels = (input: SetPinnedModelsInput) => {
		const pinnedModels = normalizePinnedModels(input.pinnedModels);
		const update = database.transaction(() => {
			const db = connect(database);
			const settings = ensureSettingsRow(db);
			requireRevision(database, settings.revision, input.expectedRevision, getKey());
			requireProfile(db, input.profileId);
			writePinnedModels(db, input.profileId, pinnedModels);
			advanceRevision(db, settings.revision);
			return read();
		});
		return update.immediate();
	};

	const replaceDiscoveryCatalog = (
		profileId: number,
		models: readonly string[],
		expectedRevision: number,
		expectedModelsUrl: string,
	) => {
		const catalog = normalizeDiscoveryCatalog(models);
		const replace = database.transaction(() => {
			const db = connect(database);
			const settings = ensureSettingsRow(db);
			const profile = requireProfile(db, profileId);
			if (
				settings.revision !== expectedRevision ||
				profile.models_url !== expectedModelsUrl
			) {
				throw new StaleConnectionSettingsRevisionError(
					expectedRevision,
					settings.revision,
					read(),
				);
			}
			db.delete(connectionProfileDiscoveryModelTable)
				.where(eq(connectionProfileDiscoveryModelTable.profile_id, profileId))
				.run();
			if (catalog.length > 0) {
				db.insert(connectionProfileDiscoveryModelTable)
					.values(catalog.map((modelId) => ({ profile_id: profileId, model_id: modelId })))
					.run();
			}
			return readProfile(db, profile, getKey());
		});
		return replace.immediate();
	};

	const resetCredential = (input: ResetConnectionCredentialInput) => {
		if (!input.confirmed) throw new ConnectionCredentialConfirmationError();
		const reset = database.transaction(() => {
			const db = connect(database);
			const settings = ensureSettingsRow(db);
			requireRevision(database, settings.revision, input.expectedRevision, getKey());
			requireProfile(db, input.profileId);
			const currentSecret = readSecret(db, input.profileId, getKey());
			if (currentSecret !== null && Object.keys(currentSecret.headers).length > 0) {
				writeSecretState(db, input.profileId, {
					credential: null,
					headers: currentSecret.headers,
				}, getKey());
			} else {
				db.delete(connectionSecretTable)
					.where(eq(connectionSecretTable.profile_id, input.profileId))
					.run();
			}
			advanceRevision(db, settings.revision);
			return read();
		});
		return reset.immediate();
	};

	return {
		get: read,
		getProfileSecrets,
		listPresets: () => listConnectionPresets().map((preset) => ({
			...preset,
			profile: cloneProfileDraft(preset.profile),
		})),
		createProfile,
		applyProfile,
		activateProfile,
		deleteProfile,
		setPinnedModels,
		replaceDiscoveryCatalog,
		setCredential,
		resetCredential,
	};
}

export function withConnectionSettings<T>(
	database: Database,
	run: (settings: ConnectionSettingsModule) => T,
	options: ConnectionSettingsModuleOptions = {},
): T {
	return run(createConnectionSettingsModule(database, options));
}

function requireRevision(
	database: Database,
	actualRevision: number,
	expectedRevision: number,
	masterKey: Uint8Array | undefined,
): void {
	if (actualRevision === expectedRevision) return;
	const current = createConnectionSettingsModule(database, {
		masterKey,
	}).get();
	throw new StaleConnectionSettingsRevisionError(
		expectedRevision,
		actualRevision,
		current,
	);
}

export {
	applyConnectionHeaderOperations,
	ConnectionCredentialConfirmationError,
	ConnectionProfileNameConflictError,
	ConnectionProfileNotFoundError,
	ConnectionProfileReplacementRequiredError,
	InvalidConnectionProfileError,
	StaleConnectionSettingsRevisionError,
	listConnectionPresets,
	validateConnectionProfileDraft,
};
export type {
	ApplyConnectionProfileInput,
	ActivateConnectionProfileInput,
	ConnectionAdapter,
	ConnectionApiFormat,
	ConnectionPreset,
	ConnectionProfile,
	ConnectionProfileDraft,
	ConnectionHeaderOperation,
	ConnectionProfileSecretSnapshot,
	ConnectionSettingsModule,
	ConnectionSettingsSnapshot,
	CreateConnectionProfileInput,
	DeleteConnectionProfileInput,
	ModelBackend,
	OutputTokenRepresentation,
	ResetConnectionCredentialInput,
	SetConnectionCredentialInput,
} from "./types";
