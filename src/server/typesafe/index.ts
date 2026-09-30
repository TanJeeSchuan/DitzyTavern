import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { typesafeSettingsTable } from "../database/schema";
import { getConnectionSecretKey } from "../connection-secrets";
import { NO_ENCRYPTED_SECRET, readEncryptedSecret, writeEncryptedSecret } from "../connection-settings/persistence";
import { fetchWithTimeout, readBoundedResponse, type ModelFetch } from "../model-client/model-fetch";
import { tokenxEstimator } from "../prompt-compiler";
import { createRevisionedSettings, InvalidSettingsError, SETTINGS_ID } from "../revisioned-settings";
import { jevResponse, type JevAnswer, type TypesafeSettingsCommand, type TypesafeSettingsPayload } from "../../shared/contract/typesafe";

const MAX_RESPONSE_BYTES = 256 * 1024;
const JEV_REQUEST_BYTE_LIMIT = 128 * 1024;
const JEV_REQUEST_TOKEN_LIMIT = 48_000;
const JEV_STATE_TOKEN_LIMIT = 16_000;
const JEV_STATE_QUESTION_TOKEN_LIMIT = 32_000;
const JEV_TOTAL_INPUT_TOKEN_LIMIT = 64_000;

export interface TypesafeSettingsModuleOptions { readonly masterKey?: Uint8Array }

const loreTriggerModeOf = (value: string): TypesafeSettingsPayload["loreTriggerMode"] => {
	if (value === "jev" || value === "off") return value;
	throw new Error("Typesafe Settings have an invalid Lore trigger mode.");
};

export const createTypesafeSettingsModule = (database: Database, options: TypesafeSettingsModuleOptions = {}) => {
	const key = () => options.masterKey === undefined ? getConnectionSecretKey() : new Uint8Array(options.masterKey);
	const settings = createRevisionedSettings(database, typesafeSettingsTable, (value): TypesafeSettingsPayload => ({
		revision: value.revision,
		jevModel: value.jev_model,
		loreTriggerMode: loreTriggerModeOf(value.lore_trigger_mode),
		loreTriggerThreshold: value.lore_trigger_threshold,
		credentialConfigured: value.key_id !== null,
	}));
	return {
		get: settings.get,
		getCredential: () => {
			const value = settings.row();
			return value.key_id === null ? null : readEncryptedSecret(value, SETTINGS_ID, key())?.credential ?? null;
		},
		apply: (command: TypesafeSettingsCommand) => {
			const jevModel = command.jevModel.trim();
			if (!jevModel) throw new InvalidSettingsError("Choose a Typesafe Jev model.");
			if (!(command.loreTriggerThreshold >= 0 && command.loreTriggerThreshold <= 1)) throw new InvalidSettingsError("The Lore trigger threshold must be between 0 and 1.");
			const secret = command.credential === undefined ? {} : command.credential.trim().length === 0 ? NO_ENCRYPTED_SECRET : writeEncryptedSecret({ credential: command.credential, headers: {} }, SETTINGS_ID, key());
			return settings.commit(command.expectedRevision, { jev_model: jevModel, lore_trigger_mode: command.loreTriggerMode, lore_trigger_threshold: command.loreTriggerThreshold, ...secret });
		},
	};
};

export const prettyJson = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };

export type JevJson = string | number | boolean | null | readonly JevJson[] | { readonly [key: string]: JevJson | undefined };

const stateFits = (state: JevJson, questions: Readonly<Record<string, JevJson>>) => {
	const questionTokens = Object.values(questions).map((question) => tokenxEstimator(JSON.stringify(question)));
	return tokenxEstimator(JSON.stringify(state)) <= Math.min(JEV_STATE_TOKEN_LIMIT, JEV_STATE_QUESTION_TOKEN_LIMIT - Math.max(0, ...questionTokens), JEV_TOTAL_INPUT_TOKEN_LIMIT - questionTokens.reduce((sum, count) => sum + count, 0));
};

export const jevRequest = (model: string, state: JevJson, questions: Readonly<Record<string, JevJson>>) => {
	const request = JSON.stringify({ model, state, questions });
	return { request, fits: new TextEncoder().encode(request).byteLength <= JEV_REQUEST_BYTE_LIMIT && tokenxEstimator(request) <= JEV_REQUEST_TOKEN_LIMIT && stateFits(state, questions) };
};

export const largestFittingBatch = <Item>(items: readonly Item[], build: (batch: readonly Item[]) => ReturnType<typeof jevRequest>) => {
	for (let size = items.length; size > 0; size--) {
		const batch = items.slice(0, size);
		const { request, fits } = build(batch);
		if (fits) return { request, items: batch };
	}
};

export const packJev = <Item>(items: readonly Item[], build: (batch: readonly Item[]) => ReturnType<typeof jevRequest>, unfittable: string, maxPerBatch = Infinity) => {
	const packed: { readonly request: string; readonly items: readonly Item[] }[] = [];
	for (let start = 0; start < items.length;) {
		const batch = largestFittingBatch(items.slice(start, start + maxPerBatch), build);
		if (batch === undefined) throw new Error(unfittable);
		packed.push(batch);
		start += batch.items.length;
	}
	return packed;
};

export type JevTrace = (label: string, fields: Readonly<Record<string, string>>) => void;

export async function requestJev(input: {
	request: string;
	credential: string;
	fetch?: ModelFetch;
	signal?: AbortSignal;
	trace?: JevTrace;
}): Promise<ReadonlyMap<string, JevAnswer>> {
	input.trace?.("Jev request", { body: prettyJson(input.request) });
	const startedAt = Date.now();
	const { response, text } = await fetchWithTimeout(input.fetch ?? fetch, "https://api.typesafe.ai/v1/systemone", {
		method: "POST",
		signal: input.signal,
		headers: { authorization: `Bearer ${input.credential}`, "content-type": "application/json" },
		body: input.request,
	}, 15_000, async (response, signal) => {
		const { bytes, truncated } = await readBoundedResponse(response, MAX_RESPONSE_BYTES, signal);
		if (truncated) throw new Error("Typesafe Jev response exceeded 256 KiB.");
		return { response, text: new TextDecoder().decode(bytes) };
	});
	input.trace?.("Jev response", { elapsed: `${((Date.now() - startedAt) / 1000).toFixed(1)} s`, status: String(response.status), body: prettyJson(text) });
	if (!response.ok) throw new Error(`Typesafe Jev request failed with HTTP ${response.status}.`);
	let answers: Record<string, JevAnswer>;
	try { answers = Value.Parse(jevResponse, JSON.parse(text)).answers; } catch { throw new Error("Typesafe Jev returned malformed or invalid JSON."); }
	const questionIds = Object.keys(JSON.parse(input.request).questions);
	if (Object.keys(answers).length !== questionIds.length || questionIds.some((id) => !Object.hasOwn(answers, id))) throw new Error("Typesafe Jev omitted or added required answers.");
	return new Map(Object.entries(answers));
}
