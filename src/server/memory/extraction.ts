import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule, connectionSnapshotOf } from "../connection-settings";
import { createModelClient, collectModelClientGeneration, type ModelFetch } from "../model-client";
import { tokenxEstimator } from "../prompt-compiler";
import type { PromptPlan } from "../prompt-compiler";
import { createMemorySettingsModule } from "./settings";
import type { MemorySettingsPayload } from "../../shared/contract/memory-settings";
import { Value } from "@sinclair/typebox/value";
import { memoryExtractionResponse, memoryJudgmentResponse } from "../../shared/contract/memory";
import type { MemoryExtractionResponse, MemoryJudgmentAnswer, MemoryJudgmentResponse } from "../../shared/contract/memory";

const MAX_CLAIM = 1024;
const MAX_EVIDENCE = 3;
const MAX_EXCERPT = 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_JEV_REQUEST_BYTES = 128 * 1024;
const MAX_JEV_RESPONSE_BYTES = 256 * 1024;

export interface CapturedMemoryMessage {
	messageId: number;
	variantId: number;
	content: string;
}
export interface MemoryEvidence { messageId: number; excerpt: string }
export interface MemoryCandidate { claim: string; attribution: string; people: string[]; evidence: MemoryEvidence[] }
export interface MemoryCandidateJudgment extends MemoryCandidate {
	judgment: {
		support: "supported" | "contradicted" | "not_established";
		usefulness: "retain" | "omit";
		probabilities: Record<string, number>;
	};
}

export function validateMemoryCandidates(
	response: MemoryExtractionResponse,
	allowedMessages: readonly CapturedMemoryMessage[],
	sourceMessageId: number,
): MemoryCandidate[] {
	const messages = new Map(allowedMessages.map((message) => [message.messageId, message.content]));
	const candidates = response.candidates.map((candidate, index): MemoryCandidate => {
		if (candidate.claim.trim().length === 0 || candidate.attribution.trim().length === 0 || candidate.claim.length + candidate.attribution.length > MAX_CLAIM) {
			throw new Error(`Memory candidate ${index + 1} needs a nonblank claim and attribution totaling at most 1,024 characters.`);
		}
		if (candidate.people.some((person) => person.trim().length === 0) || new Set(candidate.people).size !== candidate.people.length) {
			throw new Error(`Memory candidate ${index + 1} has invalid person labels.`);
		}
		if (candidate.evidence.length < 1 || candidate.evidence.length > MAX_EVIDENCE) {
			throw new Error(`Memory candidate ${index + 1} needs one to three evidence excerpts.`);
		}
		const evidence = candidate.evidence.map((entry): MemoryEvidence => {
			if (entry.excerpt.length === 0 || entry.excerpt.length > MAX_EXCERPT) throw new Error(`Memory candidate ${index + 1} has invalid evidence.`);
			const content = messages.get(entry.messageId);
			if (content === undefined || !content.includes(entry.excerpt)) throw new Error(`Memory candidate ${index + 1} cites an excerpt that is not exact captured source text.`);
			return { messageId: entry.messageId, excerpt: entry.excerpt };
		});
		if (!evidence.some((item) => item.messageId === sourceMessageId)) throw new Error(`Memory candidate ${index + 1} must cite its owning source.`);
		return { claim: candidate.claim, attribution: candidate.attribution, people: candidate.people, evidence };
	});
	return candidates.filter((candidate, index) => candidates.findIndex((other) => JSON.stringify(other) === JSON.stringify(candidate)) === index);
}

const promptPlanOf = (system: string): PromptPlan => ({
	blocks: [{ kind: "instruction", role: "system", content: system }],
	warnings: [],
});

const generatedContent = async (database: Database, memory: MemorySettingsPayload, source: CapturedMemoryMessage, context: readonly CapturedMemoryMessage[], fetcher?: ModelFetch, signal?: AbortSignal) => {
	if (tokenxEstimator(source.content) > 12_000) throw new Error("This complete source exceeds the 12,000-token Memory extraction limit. It was not truncated.");
	const retainedContext = [...context];
	while (retainedContext.length > 0 && tokenxEstimator(JSON.stringify(retainedContext)) > 2_048) retainedContext.shift();
	if (memory.extractionProfileId === null || memory.extractionModel.length === 0) throw new Error("Choose an extraction Connection Profile and model in Memory Settings.");
	const connectionSettings = createConnectionSettingsModule(database);
	const settings = connectionSettings.get();
	const profile = settings.profiles.find((item) => item.id === memory.extractionProfileId);
	if (profile === undefined) throw new Error("The selected Memory extraction Connection Profile is unavailable. Choose an available profile in Memory Settings.");
	const content = JSON.stringify({ source, precedingSelectedMessages: retainedContext });
	const instructions = `Extract durable, attributed story Memories from the supplied selected source. Preceding messages are reference only. Preserve uncertainty, negation, attribution, hearing and witnessing. Do not turn out-of-character directions into story facts. Return exactly one JSON object: {"candidates":[{"claim":"...","attribution":"...","people":["..."],"evidence":[{"messageId":1,"excerpt":"exact source text"}]}]}. Return at most 16 candidates. Each candidate must cite at least one exact excerpt from owning source message ${source.messageId}; cite only supplied message IDs; use one to three excerpts, each at most 1024 characters. Claim plus attribution may total at most 1024 characters. Empty candidates are valid. Do not use Markdown.`;
	const prompt = `${instructions}\n\nCaptured source and reference context:\n${content}`;
	if (tokenxEstimator(prompt) + memory.outputReserve + memory.safetyAllowance > memory.contextLimit) throw new Error("The complete source and extraction instructions exceed the configured Memory extraction context. Raise the extraction context limit or shorten the source.");
	const client = createModelClient({ profile, secrets: connectionSettings.getProfileSecrets(profile.id), fetch: fetcher });
	const encoder = new TextEncoder();
	let collectedOutputBytes = 0;
	const result = await collectModelClientGeneration(client, {
		promptPlan: promptPlanOf(prompt),
		modelId: memory.extractionModel,
		generationSettings: { temperature: null, topP: null, frequencyPenalty: null, presencePenalty: null, contextLimit: memory.contextLimit, responseBudget: memory.outputReserve, requestOverrides: {} },
		connection: connectionSnapshotOf(settings, profile),
		signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
	}, { onEvent: (event) => {
		if (event.type !== "content" && event.type !== "reasoning") return;
		collectedOutputBytes += encoder.encode(event.text).byteLength;
		if (collectedOutputBytes > MAX_OUTPUT_BYTES) throw new Error("Memory extraction output exceeded 64 KiB.");
	} });
	if (result.finishReason !== "stop") throw new Error(result.finishReason === "length" ? "Memory extraction output was truncated. Retry after reducing the source or increasing its output reserve." : "Memory extraction did not finish successfully. Retry this source.");
	let parsed: MemoryExtractionResponse;
	try { parsed = Value.Parse(memoryExtractionResponse, JSON.parse(result.content)); } catch { throw new Error("Memory extraction returned malformed or invalid JSON. Retry this source."); }
	return validateMemoryCandidates(parsed, [source, ...context], source.messageId);
};

const choice = (instructions: string, labels: readonly string[]) => ({
	type: "choice",
	instructions,
	criteria: Object.fromEntries(labels.map((label) => [label, (label === "not_established" || label === "omit") ? null : label === "supported" ? "The owning source evidence supports the attributed claim." : label === "contradicted" ? "The owning source evidence conflicts with the attributed claim." : "The claim is useful durable context beyond this scene."])),
});

const isChoiceLabel = <const Labels extends readonly string[]>(labels: Labels, value: string): value is Labels[number] =>
	labels.some((label) => label === value);

const parseChoice = <const Labels extends readonly string[]>(answer: MemoryJudgmentAnswer, labels: Labels) => {
	const selected = answer.choice;
	const probabilities = answer.probabilities;
	if (!isChoiceLabel(labels, selected) || Object.keys(probabilities).length !== labels.length) throw new Error("Typesafe returned a missing or malformed Memory judgment.");
	const normalized: Record<string, number> = {};
	for (const label of labels) {
		const probability = probabilities[label];
		if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("Typesafe returned incomplete Memory judgment probabilities.");
		normalized[label] = probability;
	}
	if (Math.abs(Object.values(normalized).reduce((sum, probability) => sum + probability, 0) - 1) > 0.001) throw new Error("Typesafe returned invalid Memory judgment probabilities.");
	return { label: selected, probabilities: normalized };
};

async function readBoundedResponse(response: Response, limit: number): Promise<Uint8Array> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) throw new Error("Typesafe Jev response exceeded 256 KiB.");
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > limit) { await reader.cancel(); throw new Error("Typesafe Jev response exceeded 256 KiB."); }
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return bytes;
}

export async function judgeMemoryCandidates(
	candidates: readonly MemoryCandidate[],
	credential: string,
	model = "jev-1.13.0",
	fetcher: ModelFetch = fetch,
	signal?: AbortSignal,
): Promise<MemoryCandidateJudgment[]> {
	if (candidates.length === 0) return [];
	if (!credential) throw new Error("Typesafe Jev credentials are not configured in Memory Settings.");
	const output: MemoryCandidateJudgment[] = [];
	const batches: MemoryCandidate[][] = [];
	let batch: MemoryCandidate[] = [];
	let offset = 0;
	const buildRequest = (values: readonly MemoryCandidate[], start: number) => {
		const state = { candidates: values.map((candidate, index) => ({ id: start + index, ...candidate })) };
		const questions: Record<string, ReturnType<typeof choice>> = {};
		for (const [index, candidate] of values.entries()) {
			const id = start + index;
			const evidence = JSON.stringify(candidate.evidence);
			questions[`candidate_${id}_support`] = choice(`Judge candidate identity ${id}, attributed as ${candidate.attribution}: ${candidate.claim}. Using only its cited evidence with source message identities (${evidence}), classify support.`, ["supported", "contradicted", "not_established"]);
			questions[`candidate_${id}_usefulness`] = choice(`Judge whether candidate ${id}, attributed as ${candidate.attribution}: ${candidate.claim}, is useful durable context beyond the captured source scene. Its cited evidence with source message identities is ${evidence}.`, ["retain", "omit"]);
		}
		const request = JSON.stringify({ state, model, questions });
		const bytes = new TextEncoder().encode(request).byteLength;
		const stateTokens = tokenxEstimator(JSON.stringify(state));
		const questionTokens = Object.values(questions).map((question) => tokenxEstimator(JSON.stringify(question)));
		const totalQuestionTokens = questionTokens.reduce((sum, count) => sum + count, 0);
		return { state, questions, request, fits: values.length <= 16 && bytes <= MAX_JEV_REQUEST_BYTES && tokenxEstimator(request) <= 48_000 && stateTokens <= 16_000 && stateTokens + Math.max(0, ...questionTokens) <= 32_000 && stateTokens + totalQuestionTokens <= 64_000 };
	};
	for (const candidate of candidates) {
		if (batch.length === 16 || !buildRequest([...batch, candidate], offset).fits) {
			if (batch.length === 0) throw new Error("Required Typesafe Memory evidence exceeds the bounded Jev request. No partial collection was saved.");
			batches.push(batch);
			offset += batch.length;
			batch = [];
		}
		if (!buildRequest([...batch, candidate], offset).fits) throw new Error("Required Typesafe Memory evidence exceeds the bounded Jev request. No partial collection was saved.");
		batch.push(candidate);
	}
	if (batch.length) batches.push(batch);
	offset = 0;
	for (const currentBatch of batches) {
		const { questions, request } = buildRequest(currentBatch, offset);
		const response = await fetcher("https://api.typesafe.ai/v1/systemone", {
			method: "POST", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
			headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" }, body: request,
		});
		if (!response.ok) throw new Error(`Typesafe Jev request failed with HTTP ${response.status}.`);
		const responseBytes = await readBoundedResponse(response, MAX_JEV_RESPONSE_BYTES);
		let decoded: MemoryJudgmentResponse;
		try { decoded = Value.Parse(memoryJudgmentResponse, JSON.parse(new TextDecoder().decode(responseBytes))); } catch { throw new Error("Typesafe Jev returned malformed or invalid JSON."); }
		const answers = decoded.answers;
		if (Object.keys(answers).length !== Object.keys(questions).length) throw new Error("Typesafe Jev omitted required Memory judgments.");
		for (const [index, candidate] of currentBatch.entries()) {
			const id = offset + index;
			const support = parseChoice(answers[`candidate_${id}_support`], ["supported", "contradicted", "not_established"] as const);
			const usefulness = parseChoice(answers[`candidate_${id}_usefulness`], ["retain", "omit"] as const);
			output.push({ ...candidate, judgment: { support: support.label, usefulness: usefulness.label, probabilities: { ...Object.fromEntries(Object.entries(support.probabilities).map(([key, value]) => [`support:${key}`, value])), ...Object.fromEntries(Object.entries(usefulness.probabilities).map(([key, value]) => [`usefulness:${key}`, value])) } } });
		}
		offset += currentBatch.length;
	}
	return output;
}

export async function extractAndJudgeMemorySource(database: Database, source: CapturedMemoryMessage, context: readonly CapturedMemoryMessage[], fetcher?: ModelFetch, signal?: AbortSignal): Promise<MemoryCandidateJudgment[]> {
	const settings = createMemorySettingsModule(database).get();
	const candidates = await generatedContent(database, settings, source, context, fetcher, signal);
	const credentials = createMemorySettingsModule(database).getCredential();
	const judgments = await judgeMemoryCandidates(candidates, credentials ?? "", settings.jevModel, fetcher, signal);
	return judgments.filter((candidate) => candidate.judgment.support === "supported" && candidate.judgment.usefulness === "retain");
}
