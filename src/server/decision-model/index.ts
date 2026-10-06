import type { Database } from "bun:sqlite";
import { Value } from "@sinclair/typebox/value";
import { ValueErrorType } from "@sinclair/typebox/errors";
import { decisionResponse, type DecisionAnswer, type DecisionSelection } from "../../shared/contract/decision-model";
import { resolveSystemOneRequestUrl } from "../../shared/connection-url";
import { createConnectionSettingsModule, type ConnectionSettingsModuleOptions } from "../connection-settings";
import type { ConnectionProfileDraft, ConnectionProfileSecretSnapshot } from "../connection-settings/types";
import { authenticatedHeaders } from "../model-client/authenticated-headers";
import { fetchWithTimeout, readBoundedResponse, type ModelFetch } from "../model-client/model-fetch";
import { tokenxEstimator } from "../prompt-compiler";
import { InvalidSettingsError } from "../revisioned-settings";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { connectionProfileTable } from "../database/schema";

export class DecisionModelError extends Error {
	constructor(readonly kind: "authentication" | "endpoint" | "malformed-response", message: string) { super(message); }
}

export interface ResolvedDecisionModel {
	readonly profileName: string;
	readonly model: string;
	readonly stateTokenLimit: number;
	readonly endpoint: string;
	readonly credential: string | null;
	readonly headers: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
}

export const validateDecisionSelection = (database: Database, selection: DecisionSelection) => {
	if (!Number.isSafeInteger(selection.decisionStateTokenLimit) || selection.decisionStateTokenLimit <= 0 || selection.decisionStateTokenLimit > 1_000_000) throw new InvalidSettingsError("The Decision Model state token limit must be a positive whole number no greater than 1,000,000.");
	const model = selection.decisionModel.trim();
	if (selection.decisionProfileId === null) {
		if (model) throw new InvalidSettingsError("Choose a Connection Profile before setting a Decision Model.");
		return null;
	}
	const profile = drizzle(database).select({ apiFormat: connectionProfileTable.api_format }).from(connectionProfileTable).where(eq(connectionProfileTable.id, selection.decisionProfileId)).get();
	if (!profile) throw new InvalidSettingsError("The selected Decision Model Connection Profile no longer exists. Choose an available profile.");
	if (profile.apiFormat !== "system-one") throw new InvalidSettingsError("Choose a System One connection for the Decision Model.");
	if (!model) throw new InvalidSettingsError("Choose a Decision Model for the selected Connection Profile.");
	return selection.decisionProfileId;
};

export const resolveDecisionProfile = (profile: ConnectionProfileDraft, model: string, stateTokenLimit: number, secrets: ConnectionProfileSecretSnapshot | null): ResolvedDecisionModel => {
	if (profile.apiFormat !== "system-one") throw new Error("Choose a System One connection for the Decision Model.");
	return { profileName: profile.displayName, model, stateTokenLimit, endpoint: resolveSystemOneRequestUrl(profile.requestUrl), credential: secrets?.credential ?? null, headers: secrets?.headers ?? {}, timeoutMs: profile.timeoutMs! };
};

export const resolveDecisionSelection = (database: Database, selection: DecisionSelection, options: ConnectionSettingsModuleOptions = {}): ResolvedDecisionModel | null => {
	const profileId = validateDecisionSelection(database, selection);
	if (profileId === null) return null;
	const connections = createConnectionSettingsModule(database, options);
	const profile = connections.get().profiles.find(profile => profile.id === profileId)!;
	return resolveDecisionProfile(profile, selection.decisionModel, selection.decisionStateTokenLimit, connections.getProfileSecrets(profile.id));
};

export const tryResolveDecisionSelection = (database: Database, selection: DecisionSelection, options?: ConnectionSettingsModuleOptions) => {
	try { return { decision: resolveDecisionSelection(database, selection, options), unavailableReason: undefined }; }
	catch (error) { return { decision: null, unavailableReason: error instanceof Error ? error.message : "The Decision Model is unavailable." }; }
};

export const prettyJson = (text: string) => { try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };
export type DecisionQuestions = Readonly<Record<string, { readonly type: string; readonly criteria?: Readonly<Record<string, DecisionJson>> | readonly DecisionJson[]; readonly [key: string]: DecisionJson | undefined }>>;
export type DecisionJson = string | number | boolean | null | readonly DecisionJson[] | { readonly [key: string]: DecisionJson | undefined };

const REQUEST_BYTE_LIMIT = 128 * 1024;
const REQUEST_TOKEN_LIMIT = 48_000;
const STATE_AND_QUESTION_TOKEN_LIMIT = 32_000;
const TOTAL_TOKEN_LIMIT = 64_000;

export const decisionRequest = (selection: Pick<ResolvedDecisionModel, "model" | "stateTokenLimit">, state: DecisionJson, questions: DecisionQuestions) => {
	const request = JSON.stringify({ model: selection.model, state, questions });
	const questionTokens = Object.values(questions).map(question => tokenxEstimator(JSON.stringify(question)));
	const stateLimit = Math.min(selection.stateTokenLimit, STATE_AND_QUESTION_TOKEN_LIMIT - Math.max(0, ...questionTokens), TOTAL_TOKEN_LIMIT - questionTokens.reduce((sum, count) => sum + count, 0));
	return { request, questions, fits: new TextEncoder().encode(request).byteLength <= REQUEST_BYTE_LIMIT && tokenxEstimator(request) <= REQUEST_TOKEN_LIMIT && tokenxEstimator(JSON.stringify(state)) <= stateLimit };
};

export const largestFittingBatch = <Item>(items: readonly Item[], build: (batch: readonly Item[]) => ReturnType<typeof decisionRequest>) => {
	let lower = 1;
	let upper = items.length;
	let best: { request: string; questions: DecisionQuestions; items: readonly Item[] } | undefined;
	while (lower <= upper) {
		const size = Math.floor((lower + upper) / 2);
		const batch = items.slice(0, size);
		const { request, questions, fits } = build(batch);
		if (fits) { best = { request, questions, items: batch }; lower = size + 1; }
		else upper = size - 1;
	}
	return best;
};

export const packDecisions = <Item>(items: readonly Item[], build: (batch: readonly Item[]) => ReturnType<typeof decisionRequest>, unfittable: string, maxPerBatch = Infinity) => {
	const packed: { readonly request: string; readonly questions: DecisionQuestions; readonly items: readonly Item[] }[] = [];
	for (let start = 0; start < items.length;) {
		const batch = largestFittingBatch(items.slice(start, start + maxPerBatch), build);
		if (batch === undefined) throw new Error(unfittable);
		packed.push(batch);
		start += batch.items.length;
	}
	return packed;
};

export type DecisionTrace = (label: string, fields: Readonly<Record<string, string>>) => void;

export async function requestDecisions(input: { request: string; questions: DecisionQuestions; selection: ResolvedDecisionModel; fetch?: ModelFetch; signal?: AbortSignal; trace?: DecisionTrace }): Promise<ReadonlyMap<string, DecisionAnswer>> {
	input.trace?.("Decision Model request", { body: prettyJson(input.request) });
	const startedAt = Date.now();
	const { response, text } = await fetchWithTimeout(input.fetch ?? fetch, input.selection.endpoint, {
		method: "POST", signal: input.signal,
		headers: authenticatedHeaders({ "content-type": "application/json" }, input.selection.credential, input.selection.headers), body: input.request,
	}, input.selection.timeoutMs, async (response, signal) => {
		const { bytes, truncated } = await readBoundedResponse(response, 256 * 1024, signal);
		if (truncated) throw new DecisionModelError("malformed-response", "Decision Model response exceeded 256 KiB.");
		return { response, text: new TextDecoder().decode(bytes) };
	});
	input.trace?.("Decision Model response", { elapsed: `${((Date.now() - startedAt) / 1000).toFixed(1)} s`, status: String(response.status), body: prettyJson(text) });
	if (!response.ok) throw new DecisionModelError(response.status === 401 || response.status === 403 ? "authentication" : "endpoint", `Decision Model request failed with HTTP ${response.status}.`);
	let decoded: unknown;
	try { decoded = JSON.parse(text); } catch { throw new DecisionModelError("malformed-response", "Decision Model returned invalid JSON."); }
	if (!Value.Check(decisionResponse, decoded)) {
		let schemaError = Value.Errors(decisionResponse, decoded).First()!;
		if (schemaError.type === ValueErrorType.Union) schemaError = schemaError.errors.map(errors => [...errors]).find(errors => !errors.some(error => error.path.endsWith("/type")))?.[0] ?? schemaError;
		throw new DecisionModelError("malformed-response", `Decision Model returned an invalid answer at ${schemaError.path || "/"}: ${schemaError.message}.`);
	}
	Value.Clean(decisionResponse, decoded);
	const { answers } = decoded;
	const { questions } = input;
	const ids = Object.keys(questions);
	if (Object.keys(answers).length !== ids.length || ids.some(id => !Object.hasOwn(answers, id))) throw new DecisionModelError("malformed-response", "Decision Model omitted or added required answers.");
	for (const [id, answer] of Object.entries(answers)) {
		const question = questions[id]!;
		if (answer.type !== question.type) throw new DecisionModelError("malformed-response", "Decision Model returned the wrong answer type.");
		if (answer.type === "choice") {
			const options = Object.keys(question.criteria ?? {});
			if (!options.includes(answer.choice) || Object.keys(answer.probabilities).length !== options.length || options.some(option => !Object.hasOwn(answer.probabilities, option))) throw new DecisionModelError("malformed-response", "Decision Model returned unknown or missing choice options.");
		}
	}
	return new Map(Object.entries(answers));
}
