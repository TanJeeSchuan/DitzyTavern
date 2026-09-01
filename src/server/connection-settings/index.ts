import type { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import {
	connectionProfileDiscoveryModelTable,
	connectionProfileTable,
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
	advanceRevisionWithActiveProfile,
	connect,
	ensureProfileNameAvailable,
	ensureSettingsRow,
	readProfile,
	readSecret,
	requireProfile,
	toProfileRow,
	writePinnedModels,
	writeSecretState,
} from "./persistence";
import type {
	ConnectionProfileRow,
	ConnectionSettingsDb,
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

type ConnectionSettingsRow = ReturnType<typeof ensureSettingsRow>;

interface RevisionedWriteTx {
	readonly db: ConnectionSettingsDb;
	readonly settings: ConnectionSettingsRow;
}

interface RevisionedProfileWriteTx extends RevisionedWriteTx {
	readonly profile: ConnectionProfileRow;
}

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

	function revisionedWrite(
		input: {
			readonly expectedRevision: number;
			readonly mutate: (tx: RevisionedWriteTx) => void;
		},
	): ConnectionSettingsSnapshot {
		const write = database.transaction(() => {
			const db = connect(database);
			const settings = ensureSettingsRow(db);
			requireRevision(read, settings.revision, input.expectedRevision);
			input.mutate({ db, settings });
			return read();
		});
		return write.immediate();
	}

	function revisionedProfileWrite(
		input: {
			readonly expectedRevision: number;
			readonly profileId: number;
			readonly mutate: (tx: RevisionedProfileWriteTx) => void;
		},
	): ConnectionSettingsSnapshot {
		return revisionedWrite({
			expectedRevision: input.expectedRevision,
			mutate: (tx) => {
				const profile = requireProfile(tx.db, input.profileId);
				input.mutate({ ...tx, profile });
			},
		});
	}

	const writeCredentialKeepingHeaders = (
		tx: RevisionedProfileWriteTx,
		credential: string | null,
	): void => {
		const currentSecret = readSecret(tx.db, tx.profile.id, getKey());
		writeSecretState(tx.db, tx.profile.id, {
			credential,
			headers: currentSecret?.headers ?? {},
		}, getKey());
	};

	const createProfile = (input: CreateConnectionProfileInput) => {
		const profile = validateConnectionProfileDraft(input.profile);
		const credential = normalizeCredential(input.credential);
		const headerOperations = validateHeaderOperations(input.headers ?? []);
		return revisionedWrite({
			expectedRevision: input.expectedRevision,
			mutate: ({ db, settings }) => {
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

				advanceRevisionWithActiveProfile(
					db,
					settings.revision,
					settings.active_profile_id ?? inserted.id,
				);
			},
		});
	};

	const applyProfile = (input: ApplyConnectionProfileInput) => {
		const profile = validateConnectionProfileDraft(input.profile);
		const headerOperations = validateHeaderOperations(input.headers ?? []);
		return revisionedProfileWrite({
			expectedRevision: input.expectedRevision,
			profileId: input.profileId,
			mutate: ({ db, profile: current, settings }) => {
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
				advanceRevision(db, settings.revision);
			},
		});
	};

	const activateProfile = (input: ActivateConnectionProfileInput) =>
		revisionedProfileWrite({
			expectedRevision: input.expectedRevision,
			profileId: input.profileId,
			mutate: ({ db, settings }) => {
				if (settings.active_profile_id === input.profileId) return;
				advanceRevisionWithActiveProfile(db, settings.revision, input.profileId);
			},
		});

	const deleteProfile = (input: DeleteConnectionProfileInput) =>
		revisionedProfileWrite({
			expectedRevision: input.expectedRevision,
			profileId: input.profileId,
			mutate: ({ db, settings }) => {
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

				advanceRevisionWithActiveProfile(db, settings.revision, nextActiveProfileId);
				db.delete(connectionProfileTable)
					.where(eq(connectionProfileTable.id, input.profileId))
					.run();
			},
		});

	const setCredential = (input: SetConnectionCredentialInput) => {
		if (input.credential.trim().length === 0) {
			throw new InvalidConnectionProfileError("A Connection Credential is required.");
		}
		return revisionedProfileWrite({
			expectedRevision: input.expectedRevision,
			profileId: input.profileId,
			mutate: (tx) => {
				writeCredentialKeepingHeaders(tx, input.credential);
				advanceRevision(tx.db, tx.settings.revision);
			},
		});
	};

	const setPinnedModels = (input: SetPinnedModelsInput) => {
		const pinnedModels = normalizePinnedModels(input.pinnedModels);
		return revisionedProfileWrite({
			expectedRevision: input.expectedRevision,
			profileId: input.profileId,
			mutate: ({ db, settings }) => {
				writePinnedModels(db, input.profileId, pinnedModels);
				advanceRevision(db, settings.revision);
			},
		});
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
		return revisionedProfileWrite({
			expectedRevision: input.expectedRevision,
			profileId: input.profileId,
			mutate: (tx) => {
				writeCredentialKeepingHeaders(tx, null);
				advanceRevision(tx.db, tx.settings.revision);
			},
		});
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
	read: () => ConnectionSettingsSnapshot,
	actualRevision: number,
	expectedRevision: number,
): void {
	if (actualRevision === expectedRevision) return;
	throw new StaleConnectionSettingsRevisionError(expectedRevision, actualRevision, read());
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
