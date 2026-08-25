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
import type {
	ApplyConnectionProfileInput,
	ActivateConnectionProfileInput,
	ConnectionProfile,
	ConnectionProfileDraft,
	ConnectionHeaderOperation,
	ConnectionProfileSecretSnapshot,
	ConnectionSettingsModule,
	ConnectionSettingsSnapshot,
	CreateConnectionProfileInput,
	BackendOptions,
	DeleteConnectionProfileInput,
	SetPinnedModelsInput,
	ResetConnectionCredentialInput,
	SetConnectionCredentialInput,
} from "./types";

const SETTINGS_ROW_ID = 1;

export interface ConnectionSettingsModuleOptions {
	readonly masterKey?: Uint8Array;
}

type ConnectionProfileRow = typeof connectionProfileTable.$inferSelect;

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
		const profile = validateProfile(input.profile);
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
		const profile = validateProfile(input.profile);
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

	const replaceDiscoveryCatalog = (profileId: number, models: readonly string[]) => {
		const catalog = normalizeDiscoveryCatalog(models);
		const replace = database.transaction(() => {
			const db = connect(database);
			const profile = requireProfile(db, profileId);
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

function connect(database: Database) {
	// Keeping the Drizzle wrapper local gives every operation the same typed
	// database seam while the transaction itself remains owned by SQLite.
	return (awaitableDrizzle(database));
}

// This indirection keeps the return type inferred from the schema without
// importing a mutable singleton database wrapper into the domain module.
function awaitableDrizzle(database: Database) {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-call
	return drizzle(database);
}

function ensureSettingsRow(db: ReturnType<typeof awaitableDrizzle>) {
	db.insert(connectionSettingsTable)
		.values({ id: SETTINGS_ROW_ID, revision: 0, active_profile_id: null })
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

function readProfile(
	db: ReturnType<typeof awaitableDrizzle>,
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
	const backendOptions = parseBackendOptions(row.backend_options_json);
	return {
		id: row.id,
		displayName: row.display_name,
		// SAFETY: these fields are validated by validateProfile before they are
		// inserted; the assertions restore the closed domain vocabulary on read.
		apiFormat: row.api_format as ConnectionProfile["apiFormat"],
		requestUrl: row.request_url,
		modelsUrl: row.models_url,
		// SAFETY: validateProfile rejects every Model Backend value outside the
		// closed v1 vocabulary before the row can be written.
		modelBackend: row.model_backend as ConnectionProfile["modelBackend"],
		// SAFETY: validateProfile rejects every Adapter value outside the three
		// bundled adapter identifiers before the row can be written.
		adapter: row.adapter as ConnectionProfile["adapter"],
		// SAFETY: validateProfile rejects every output-token representation that
		// is not part of the Chat Completions v1 vocabulary.
		outputTokenRepresentation: row.output_token_representation as ConnectionProfile["outputTokenRepresentation"],
		timeoutMs: row.timeout_ms,
		pinnedModels: pins,
		discoveryCatalog: normalizeDiscoveryCatalog(discoveryCatalog),
		backendOptions,
		credentialConfigured,
		headers,
	};
}

function readSecret(
	db: ReturnType<typeof awaitableDrizzle>,
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
		// SAFETY: the encryption module accepts the versioned value and
		// rejects any unsupported value before decrypting it.
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

function validateProfile(input: ConnectionProfileDraft): ConnectionProfileDraft {
	const displayName = normalizeDisplayName(input.displayName);
	if (input.apiFormat !== "chat-completions") {
		throw new InvalidConnectionProfileError(
			"Only the Chat Completions API Format is available in version one.",
		);
	}
	if (input.modelBackend !== "automatic" && input.modelBackend !== "ai-sdk") {
		throw new InvalidConnectionProfileError("The selected Model Backend is unavailable.");
	}
	if (![
		"openai-compatible",
		"deepseek",
		"openrouter",
	].includes(input.adapter)) {
		throw new InvalidConnectionProfileError("The selected AI SDK Adapter is unavailable.");
	}
	if (![
		"automatic",
		"max_tokens",
		"max_completion_tokens",
		"omit",
	].includes(input.outputTokenRepresentation)) {
		throw new InvalidConnectionProfileError(
			"The selected output-token representation is unavailable.",
		);
	}
	const requestUrl = validateUrl(input.requestUrl, "request URL", true);
	const modelsUrl = validateUrl(input.modelsUrl, "Models URL", true);
	if (
		input.timeoutMs !== null &&
		(!Number.isInteger(input.timeoutMs) || input.timeoutMs < 0)
	) {
		throw new InvalidConnectionProfileError(
			"Timeout must be zero, null, or a positive whole number of milliseconds.",
		);
	}
	const pinnedModels = normalizePinnedModels(input.pinnedModels);
	const backendOptions = input.backendOptions ?? {};
	if (Object.keys(backendOptions).length > 0) {
		throw new InvalidConnectionProfileError(
			"Arbitrary Backend Options are not supported in version one.",
		);
	}
	return {
		displayName,
		apiFormat: "chat-completions",
		requestUrl,
		modelsUrl,
		modelBackend: input.modelBackend,
		adapter: input.adapter,
		outputTokenRepresentation: input.outputTokenRepresentation,
		timeoutMs: input.timeoutMs,
		pinnedModels,
		backendOptions,
	};
}

export function validateConnectionProfileDraft(
	profile: ConnectionProfileDraft,
): ConnectionProfileDraft {
	return validateProfile(profile);
}

export function applyConnectionHeaderOperations(
	current: ConnectionProfileSecretSnapshot | null,
	operations: readonly ConnectionHeaderOperation[],
): ConnectionProfileSecretSnapshot | null {
	const validated = validateHeaderOperations(operations);
	const headers = applyHeaderOperations(current?.headers ?? {}, validated);
	if ((current?.credential ?? null) === null && Object.keys(headers).length === 0) return null;
	return { credential: current?.credential ?? null, headers };
}

function normalizeDisplayName(value: string): string {
	const normalized = value.trim().replace(/\s+/g, " ");
	if (normalized.length === 0) {
		throw new InvalidConnectionProfileError("A Connection Profile display name is required.");
	}
	return normalized;
}

function ensureProfileNameAvailable(
	db: ReturnType<typeof awaitableDrizzle>,
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

function validateUrl(value: string, label: string, allowBlank: boolean): string {
	const normalized = value.trim();
	if (normalized.length === 0) {
		if (allowBlank) return "";
		throw new InvalidConnectionProfileError(`A ${label} is required.`);
	}
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new InvalidConnectionProfileError(`The ${label} must be a valid HTTP or HTTPS URL.`);
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		parsed.hash.length > 0
	) {
		throw new InvalidConnectionProfileError(
			`${label} must use HTTP or HTTPS without user information or a fragment.`,
		);
	}
	return normalized;
}

function normalizePinnedModels(models: readonly string[]): string[] {
	const result: string[] = [];
	for (const model of models) {
		const normalized = model.trim();
		if (normalized.length === 0) {
			throw new InvalidConnectionProfileError("Pinned model IDs cannot be blank.");
		}
		if (!result.includes(normalized)) result.push(normalized);
	}
	return result;
}

export function normalizeDiscoveryCatalog(models: readonly string[]): string[] {
	const unique = new Set<string>();
	for (const model of models) {
		const normalized = model.trim();
		if (normalized.length > 0) unique.add(normalized);
	}
	return [...unique].sort(compareModelIds);
}

function compareModelIds(left: string, right: string): number {
	const leftFolded = left.toLocaleLowerCase();
	const rightFolded = right.toLocaleLowerCase();
	if (leftFolded < rightFolded) return -1;
	if (leftFolded > rightFolded) return 1;
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}

function toProfileRow(profile: ConnectionProfileDraft) {
	return {
		display_name: profile.displayName,
		api_format: profile.apiFormat,
		request_url: profile.requestUrl,
		models_url: profile.modelsUrl,
		model_backend: profile.modelBackend,
		adapter: profile.adapter,
		output_token_representation: profile.outputTokenRepresentation,
		timeout_ms: profile.timeoutMs,
		backend_options_json: JSON.stringify(profile.backendOptions ?? {}),
	};
}

function writePinnedModels(
	db: ReturnType<typeof awaitableDrizzle>,
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

function writeSecretState(
	db: ReturnType<typeof awaitableDrizzle>,
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

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TRANSPORT_OWNED_HEADERS = new Set([
	"accept-encoding",
	"connection",
	"content-encoding",
	"content-length",
	"content-type",
	"host",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

function validateHeaderOperations(
	operations: readonly ConnectionHeaderOperation[],
): readonly ConnectionHeaderOperation[] {
	const seen = new Set<string>();
	return operations.map((operation) => {
		const normalized = operation.name.toLowerCase();
		if (!HTTP_TOKEN.test(operation.name) || TRANSPORT_OWNED_HEADERS.has(normalized)) {
			throw new InvalidConnectionProfileError(
				`Custom header name "${operation.name}" is not a valid user-controlled HTTP header.`,
			);
		}
		if (seen.has(normalized)) {
			throw new InvalidConnectionProfileError(
				`Custom header names must be unique case-insensitively: "${operation.name}".`,
			);
		}
		seen.add(normalized);
		return operation;
	});
}

function applyHeaderOperations(
	current: Readonly<Record<string, string>>,
	operations: readonly ConnectionHeaderOperation[],
): ConnectionProfileSecretSnapshot["headers"] {
	const next = { ...current } satisfies ConnectionProfileSecretSnapshot["headers"];
	for (const operation of operations) {
		const existingName = Object.keys(next).find(
			(name) => name.toLowerCase() === operation.name.toLowerCase(),
		);
		if (operation.operation === "keep") continue;
		if (operation.operation === "remove") {
			if (existingName !== undefined) delete next[existingName];
			continue;
		}
		if (existingName !== undefined) delete next[existingName];
		next[operation.name] = operation.value;
	}
	return next;
}

function advanceRevision(
	db: ReturnType<typeof awaitableDrizzle>,
	revision: number,
): void {
	db.update(connectionSettingsTable)
		.set({ revision: revision + 1 })
		.where(eq(connectionSettingsTable.id, SETTINGS_ROW_ID))
		.run();
}

function requireProfile(
	db: ReturnType<typeof awaitableDrizzle>,
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

function normalizeCredential(value: string | null | undefined): string | null {
	if (value === undefined || value === null || value.length === 0) return null;
	if (value.trim().length === 0) return null;
	return value;
}

function parseBackendOptions(value: string): BackendOptions {
	try {
		// SAFETY: this value is written only by toProfileRow after the domain
		// validates the profile draft's BackendOptions shape.
		const parsed = JSON.parse(value) as BackendOptions;
		if (Object.keys(parsed).length > 0) throw new Error("non-empty");
		return {};
	} catch {
		throw new InvalidConnectionProfileError("Stored Backend Options are invalid JSON.");
	}
}

export {
	ConnectionCredentialConfirmationError,
	ConnectionProfileNameConflictError,
	ConnectionProfileNotFoundError,
	ConnectionProfileReplacementRequiredError,
	InvalidConnectionProfileError,
	StaleConnectionSettingsRevisionError,
	listConnectionPresets,
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
