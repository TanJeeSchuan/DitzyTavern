import type { Database } from "bun:sqlite";
import { asc, eq, isNull } from "drizzle-orm";
import {
	connectionProfileDiscoveryModelTable,
	connectionProfileTable,
	conversationGenerationSettingsTable,
} from "../database/schema";
import {
	getConnectionSecretKey,
} from "../connection-secrets";
import {
	ConnectionCredentialConfirmationError,
	ConnectionProfileNameConflictError,
	ConnectionProfileNotFoundError,
	InvalidConnectionProfileError,
	StaleConnectionSettingsRevisionError,
} from "./errors";
import {
	listConnectionPresets,
} from "./presets";
import { connectionProfileDraftOf } from "../../shared/contract/connection-settings";
import type { ModelClientConnectionSnapshot } from "../model-client/types";
import {
	advanceRevision,
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
	ConnectionProfile,
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

// ==[HUMAN APPROVED]== Every successful revisioned mutation advances the
// Connection Settings revision exactly once.
type RevisionedWriteOutcome = { readonly kind: "advanced" };

export interface ConnectionSettingsModuleOptions {
	readonly masterKey?: Uint8Array;
}

/** ==[HUMAN APPROVED]==
 * Creates the safe connection identity captured by runtime attempts and
 * persisted for generation inspection. Both paths use this constructor so
 * their provenance cannot disagree about the selected Profile or revision.
 */
export function connectionSnapshotOf(
	settings: ConnectionSettingsSnapshot,
	profile: ConnectionProfile,
): ModelClientConnectionSnapshot {
	if (profile.apiFormat === "embeddings") throw new Error(`${profile.displayName} is an Embeddings connection. Choose a chat model instead.`);
	return {
		profileId: profile.id,
		settingsRevision: settings.revision,
		backend: "ai-sdk",
		adapter: profile.adapter,
		apiFormat: profile.apiFormat,
	};
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
		return {
			revision: settings.revision,
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

	// ==[HUMAN APPROVED]== One seam owns connect, ensure, revision check, mutate, and the
	// revision advance, so every successful write bumps the revision exactly
	// once by construction rather than by caller discipline.
	function revisionedWrite(
		input: {
			readonly expectedRevision: number;
			readonly mutate: (tx: RevisionedWriteTx) => RevisionedWriteOutcome;
		},
	): ConnectionSettingsSnapshot {
		const write = database.transaction(() => {
			const db = connect(database);
			const settings = ensureSettingsRow(db);
			requireRevision(read, settings.revision, input.expectedRevision);
			input.mutate({ db, settings });
			advanceRevision(db, settings.revision);
			return read();
		});
		return write.immediate();
	}

	function revisionedProfileWrite(
		input: {
			readonly expectedRevision: number;
			readonly profileId: number;
			readonly mutate: (tx: RevisionedProfileWriteTx) => RevisionedWriteOutcome;
		},
	): ConnectionSettingsSnapshot {
		return revisionedWrite({
			expectedRevision: input.expectedRevision,
			mutate: (tx) => {
				const profile = requireProfile(tx.db, input.profileId);
				return input.mutate({ ...tx, profile });
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
			mutate: ({ db }) => {
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
				if (profile.apiFormat !== "embeddings") db.update(conversationGenerationSettingsTable)
					.set({ connection_profile_id: inserted.id })
					.where(isNull(conversationGenerationSettingsTable.connection_profile_id))
					.run();
				writeSecretState(db, inserted.id, {
					credential,
					headers: applyHeaderOperations({}, headerOperations),
				}, getKey());

				return { kind: "advanced" };
			},
		});
	};

	const applyProfile = (input: ApplyConnectionProfileInput) => {
		const profile = validateConnectionProfileDraft(input.profile);
		if (input.credential !== undefined && input.credential.trim().length === 0) throw new InvalidConnectionProfileError("A Connection Credential is required.");
		const credential = input.credential === undefined ? undefined : normalizeCredential(input.credential);
		const headerOperations = validateHeaderOperations(input.headers ?? []);
		return revisionedProfileWrite({
			expectedRevision: input.expectedRevision,
			profileId: input.profileId,
			mutate: ({ db, profile: current }) => {
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
					credential: credential === undefined ? currentSecret?.credential ?? null : credential,
					headers: applyHeaderOperations(currentSecret?.headers ?? {}, headerOperations),
				}, getKey());
				return { kind: "advanced" };
			},
		});
	};

	const deleteProfile = (input: DeleteConnectionProfileInput) =>
		revisionedProfileWrite({
			expectedRevision: input.expectedRevision,
			profileId: input.profileId,
			mutate: ({ db }) => {

				// ==[HUMAN APPROVED]== The row is deleted before the seam advances: when the deleted
				// Profile holds the active seat, the foreign key nulls the selection
				// (PRAGMA foreign_keys is ON), and the seam then writes the returned
				// replacement id — the same final state, still one immediate
				// transaction.
				db.delete(connectionProfileTable)
					.where(eq(connectionProfileTable.id, input.profileId))
					.run();
				return { kind: "advanced" };
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
				return { kind: "advanced" };
			},
		});
	};

	const setPinnedModels = (input: SetPinnedModelsInput) => {
		const pinnedModels = normalizePinnedModels(input.pinnedModels);
		return revisionedProfileWrite({
			expectedRevision: input.expectedRevision,
			profileId: input.profileId,
			mutate: ({ db }) => {
				writePinnedModels(db, input.profileId, pinnedModels);
				return { kind: "advanced" };
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
				return { kind: "advanced" };
			},
		});
	};

	return {
		get: read,
		getProfileSecrets,
		listPresets: () => listConnectionPresets().map((preset) => ({
			...preset,
			profile: connectionProfileDraftOf(preset.profile),
		})),
		createProfile,
		applyProfile,
		deleteProfile,
		setPinnedModels,
		replaceDiscoveryCatalog,
		setCredential,
		resetCredential,
	};
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
	connectionProfileDraftOf,
	ConnectionCredentialConfirmationError,
	ConnectionProfileNameConflictError,
	ConnectionProfileNotFoundError,
	InvalidConnectionProfileError,
	StaleConnectionSettingsRevisionError,
	listConnectionPresets,
	validateConnectionProfileDraft,
};
export type {
	ApplyConnectionProfileInput,
	ConnectionAdapter,
	ChatApiFormat,
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
