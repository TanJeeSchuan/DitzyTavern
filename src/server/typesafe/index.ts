import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Value } from "@sinclair/typebox/value";
import { typesafeSecretTable, typesafeSettingsTable } from "../database/schema";
import { decryptConnectionSecretSync, encryptConnectionSecretSync, getConnectionSecretKey } from "../connection-secrets";
import type { ModelFetch } from "../model-client";
import { tokenxEstimator } from "../prompt-compiler";
import { jevResponse, type JevAnswer, type TypesafeSettingsCommand, type TypesafeSettingsPayload } from "../../shared/contract/typesafe";

const SETTINGS_ID = 1;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
export const JEV_STATE_TOKEN_LIMIT = 16_000;
type Db = ReturnType<typeof drizzle>;

export class InvalidTypesafeSettingsError extends Error {
	constructor(message: string) { super(message); this.name = "InvalidTypesafeSettingsError"; }
}
export class StaleTypesafeSettingsError extends Error {
	constructor(readonly expectedRevision: number, readonly actualRevision: number, readonly currentSettings: TypesafeSettingsPayload) {
		super(`Expected Typesafe Settings revision ${expectedRevision}, but the current revision is ${actualRevision}.`);
		this.name = "StaleTypesafeSettingsError";
	}
}
export interface TypesafeSettingsModuleOptions { readonly masterKey?: Uint8Array }

const loreTriggerModeOf = (value: string): TypesafeSettingsPayload["loreTriggerMode"] => {
	if (value === "jev" || value === "off") return value;
	throw new Error("Typesafe Settings have an invalid Lore trigger mode.");
};

export const createTypesafeSettingsModule = (database: Database, options: TypesafeSettingsModuleOptions = {}) => {
	const db = drizzle(database);
	const key = () => options.masterKey === undefined ? getConnectionSecretKey() : new Uint8Array(options.masterKey);
	const row = () => {
		db.insert(typesafeSettingsTable).values({ id: SETTINGS_ID }).onConflictDoNothing().run();
		const value = db.select().from(typesafeSettingsTable).where(eq(typesafeSettingsTable.id, SETTINGS_ID)).get();
		if (!value) throw new Error("Typesafe Settings are unavailable.");
		return value;
	};
	const get = (): TypesafeSettingsPayload => {
		const value = row();
		return {
			revision: value.revision,
			jevModel: value.jev_model,
			loreTriggerMode: loreTriggerModeOf(value.lore_trigger_mode),
			loreTriggerThreshold: value.lore_trigger_threshold,
			credentialConfigured: db.select({ id: typesafeSecretTable.id }).from(typesafeSecretTable).where(eq(typesafeSecretTable.id, SETTINGS_ID)).get() !== undefined,
		};
	};
	const getCredential = (): string | null => {
		const value = db.select().from(typesafeSecretTable).where(eq(typesafeSecretTable.id, SETTINGS_ID)).get();
		if (!value) return null;
		return decryptConnectionSecretSync(key(), SETTINGS_ID, {
			// ==[HUMAN APPROVED]== SAFETY: This module's encrypted-secret writer stores version 1, and decryption rejects unsupported versions.
			formatVersion: value.format_version as 1, keyId: value.key_id, nonce: value.nonce,
			ciphertext: value.ciphertext, tag: value.tag,
		}).credential;
	};
	const writeSecret = (connection: Db, credential: string | null) => {
		if (credential === null || credential.trim().length === 0) {
			connection.delete(typesafeSecretTable).where(eq(typesafeSecretTable.id, SETTINGS_ID)).run();
			return;
		}
		const secret = encryptConnectionSecretSync(key(), SETTINGS_ID, { credential, headers: {} });
		connection.insert(typesafeSecretTable).values({ id: SETTINGS_ID, format_version: secret.formatVersion, key_id: secret.keyId, nonce: secret.nonce, ciphertext: secret.ciphertext, tag: secret.tag }).onConflictDoUpdate({
			target: typesafeSecretTable.id,
			set: { format_version: secret.formatVersion, key_id: secret.keyId, nonce: secret.nonce, ciphertext: secret.ciphertext, tag: secret.tag },
		}).run();
	};
	const commit = (expectedRevision: number, mutate: (connection: Db) => void) => database.transaction(() => {
		const current = row();
		if (current.revision !== expectedRevision) throw new StaleTypesafeSettingsError(expectedRevision, current.revision, get());
		mutate(db);
		db.update(typesafeSettingsTable).set({ revision: current.revision + 1 }).where(eq(typesafeSettingsTable.id, SETTINGS_ID)).run();
		return get();
	}).immediate();
	return {
		get,
		getCredential,
		apply: (command: Extract<TypesafeSettingsCommand, { type: "apply" }>) => {
			const jevModel = command.jevModel.trim();
			if (!jevModel) throw new InvalidTypesafeSettingsError("Choose a Typesafe Jev model.");
			if (!(command.loreTriggerThreshold >= 0 && command.loreTriggerThreshold <= 1)) throw new InvalidTypesafeSettingsError("The Lore trigger threshold must be between 0 and 1.");
			return commit(command.expectedRevision, (connection) => {
				connection.update(typesafeSettingsTable).set({ jev_model: jevModel, lore_trigger_mode: command.loreTriggerMode, lore_trigger_threshold: command.loreTriggerThreshold }).where(eq(typesafeSettingsTable.id, SETTINGS_ID)).run();
				if (command.credential !== undefined) writeSecret(connection, command.credential);
			});
		},
		resetCredential: (command: Extract<TypesafeSettingsCommand, { type: "reset-credential" }>) => {
			if (!command.confirmed) throw new InvalidTypesafeSettingsError("Resetting the Typesafe credential requires confirmation.");
			return commit(command.expectedRevision, (connection) => writeSecret(connection, null));
		},
	};
};

async function readBoundedResponse(response: Response): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("Typesafe Jev response exceeded 256 KiB.");
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("Typesafe Jev response exceeded 256 KiB."); }
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return new TextDecoder().decode(bytes);
}

const prettyJson = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };

export const jevRequest = <State extends object, Question extends object>(model: string, state: State, questions: Readonly<Record<string, Question>>) => {
	const request = JSON.stringify({ model, state, questions });
	const stateTokens = tokenxEstimator(JSON.stringify(state));
	const questionTokens = Object.values(questions).map((question) => tokenxEstimator(JSON.stringify(question)));
	const totalQuestionTokens = questionTokens.reduce((sum, count) => sum + count, 0);
	const fits = new TextEncoder().encode(request).byteLength <= MAX_REQUEST_BYTES && tokenxEstimator(request) <= 48_000 && stateTokens <= JEV_STATE_TOKEN_LIMIT && stateTokens + Math.max(0, ...questionTokens) <= 32_000 && stateTokens + totalQuestionTokens <= 64_000;
	return { request, questionIds: Object.keys(questions), fits };
};

export type JevTrace = (label: string, fields: Readonly<Record<string, string>>) => void;

export async function requestJev(input: {
	request: string;
	questionIds: readonly string[];
	credential: string;
	fetch?: ModelFetch;
	signal?: AbortSignal;
	trace?: JevTrace;
}): Promise<Readonly<Record<string, JevAnswer>>> {
	input.trace?.("Jev request", { body: prettyJson(input.request) });
	const startedAt = Date.now();
	const response = await (input.fetch ?? fetch)("https://api.typesafe.ai/v1/systemone", {
		method: "POST",
		signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
		headers: { authorization: `Bearer ${input.credential}`, "content-type": "application/json" },
		body: input.request,
	});
	const text = await readBoundedResponse(response);
	input.trace?.("Jev response", { elapsed: `${((Date.now() - startedAt) / 1000).toFixed(1)} s`, status: String(response.status), body: prettyJson(text) });
	if (!response.ok) throw new Error(`Typesafe Jev request failed with HTTP ${response.status}.`);
	let answers: Record<string, JevAnswer>;
	try { answers = Value.Parse(jevResponse, JSON.parse(text)).answers; } catch { throw new Error("Typesafe Jev returned malformed or invalid JSON."); }
	const actual = Object.keys(answers);
	if (actual.length !== input.questionIds.length || input.questionIds.some((id) => !Object.hasOwn(answers, id))) throw new Error("Typesafe Jev omitted or added required answers.");
	return answers;
}
