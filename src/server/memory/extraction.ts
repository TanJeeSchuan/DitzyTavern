import type { Database } from "bun:sqlite";
import { createConnectionSettingsModule, connectionSnapshotOf } from "../connection-settings";
import { createModelClient, collectModelClientGeneration, type ModelFetch } from "../model-client";
import { tokenxEstimator } from "../prompt-compiler";
import type { PromptPlan } from "../prompt-compiler";
import { createMemorySettingsModule } from "./settings";
import type { MemorySettingsPayload } from "../../shared/contract/memory-settings";
import { Value } from "@sinclair/typebox/value";
import { memoryExtractionResponse } from "../../shared/contract/memory";
import type { CapturedMemoryMessage, MemoryCandidate, MemoryCandidateJudgment, MemoryExtractionResponse } from "../../shared/contract/memory";
import type { JevAnswer } from "../../shared/contract/typesafe";
import { createTypesafeSettingsModule, jevRequest, packJev, prettyJson, requestJev, type JevTrace } from "../typesafe";
import { hasValidMemoryClaimText, hasValidMemoryPeople } from "./claim-validation";

const MAX_EVIDENCE = 3;
const MAX_EXCERPT = 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const EXTRACTION_DEADLINE_MS = 10 * 60 * 1000;

export type MemoryTrace = JevTrace;
const noTrace: MemoryTrace = () => {};
const seconds = (startedAt: number) => `${((Date.now() - startedAt) / 1000).toFixed(1)} s`;

const candidateProblem = (candidate: MemoryExtractionResponse["candidates"][number], messages: ReadonlyMap<number, string>, sourceMessageId: number): string | null => {
	if (!hasValidMemoryClaimText(candidate.claim, candidate.attribution)) return "needs a nonblank claim and attribution totaling at most 1,024 characters";
	if (!hasValidMemoryPeople(candidate.people)) return "has invalid person labels";
	if (candidate.evidence.length < 1 || candidate.evidence.length > MAX_EVIDENCE) return "needs one to three evidence excerpts";
	if (candidate.evidence.some((entry) => entry.excerpt.length === 0 || entry.excerpt.length > MAX_EXCERPT)) return "has invalid evidence";
	if (candidate.evidence.some((entry) => !messages.get(entry.messageId)?.includes(entry.excerpt))) return "cites an excerpt that is not exact captured source text";
	if (!candidate.evidence.some((entry) => entry.messageId === sourceMessageId)) return "must cite its owning source";
	return null;
};

export function validateMemoryCandidates(
	response: MemoryExtractionResponse,
	allowedMessages: readonly CapturedMemoryMessage[],
	sourceMessageId: number,
) {
	const messages = new Map(allowedMessages.map((message) => [message.messageId, message.content]));
	const valid: MemoryCandidate[] = [];
	const dropped: string[] = [];
	for (const [index, candidate] of response.candidates.entries()) {
		const problem = candidateProblem(candidate, messages, sourceMessageId);
		if (problem !== null) dropped.push(`Memory candidate ${index + 1} ${problem}.`);
		else valid.push({ claim: candidate.claim, attribution: candidate.attribution, people: candidate.people, evidence: candidate.evidence.map(({ messageId, excerpt }) => ({ messageId, excerpt })) });
	}
	if (valid.length === 0 && dropped.length > 0) throw new Error(`Every Memory candidate was invalid. ${dropped.join(" ")}`);
	return { candidates: valid.filter((candidate, index) => valid.findIndex((other) => JSON.stringify(other) === JSON.stringify(candidate)) === index), dropped };
}

const promptPlanOf = (system: string): PromptPlan => ({
	blocks: [{ kind: "instruction", role: "system", content: system }],
	warnings: [],
	sendImages: true, images: [],
});

const generatedContent = async (database: Database, memory: MemorySettingsPayload, source: CapturedMemoryMessage, context: readonly CapturedMemoryMessage[], fetcher?: ModelFetch, signal?: AbortSignal, trace: MemoryTrace = noTrace) => {
	if (tokenxEstimator(source.content) > 12_000) throw new Error("This complete source exceeds the 12,000-token Memory extraction limit. It was not truncated.");
	if (memory.extractionProfileId === null || memory.extractionModel.length === 0) throw new Error("Choose an extraction Connection Profile and model in Memory Settings.");
	const connectionSettings = createConnectionSettingsModule(database);
	const settings = connectionSettings.get();
	const profile = settings.profiles.find((item) => item.id === memory.extractionProfileId);
	if (profile === undefined) throw new Error("The selected Memory extraction Connection Profile is unavailable. Choose an available profile in Memory Settings.");
	const instructions = `Extract durable, attributed story Memories from the supplied selected source. Preceding messages are reference only. Each message's speaker is its captured author name, or null when unknown. Use that name to resolve first-person references when appropriate; an author can narrate or quote other people, so do not assume every claim concerns the author. Use consistent person names in people, not transport roles such as user or assistant unless those are actual names in the story. Preserve uncertainty, negation, attribution, hearing and witnessing. Do not turn out-of-character directions into story facts. Return exactly one JSON object: {"candidates":[{"claim":"...","attribution":"...","people":["..."],"evidence":[{"messageId":1,"excerpt":"exact source text"}]}]}. Return at most 16 candidates. Each candidate must cite at least one exact excerpt from owning source message ${source.messageId}; cite only supplied message IDs; use one to three excerpts, each at most 1024 characters. Claim plus attribution may total at most 1024 characters. Empty candidates are valid. Do not use Markdown.`;
	const promptOf = (retained: readonly CapturedMemoryMessage[]) => `${instructions}\n\nCaptured source and reference context:\n${JSON.stringify({ source, precedingSelectedMessages: retained })}`;
	const exceedsContext = (retained: readonly CapturedMemoryMessage[]) => tokenxEstimator(promptOf(retained)) + memory.outputReserve + memory.safetyAllowance > memory.contextLimit;
	const retainedContext = [...context];
	while (retainedContext.length > 0 && (tokenxEstimator(JSON.stringify(retainedContext)) > 2_048 || exceedsContext(retainedContext))) retainedContext.shift();
	const prompt = promptOf(retainedContext);
	if (exceedsContext(retainedContext)) throw new Error("The complete source and extraction instructions exceed the configured Memory extraction context. Raise the extraction context limit or shorten the source.");
	const client = createModelClient({ profile, secrets: connectionSettings.getProfileSecrets(profile.id), fetch: fetcher });
	const encoder = new TextEncoder();
	let collectedOutputBytes = 0;
	trace("Extraction request", { profile: profile.displayName, model: memory.extractionModel, limits: `context ${memory.contextLimit} · output reserve ${memory.outputReserve}`, contextMessageIds: retainedContext.map((message) => message.messageId).join(", "), prompt });
	const startedAt = Date.now();
	const deadline = AbortSignal.timeout(EXTRACTION_DEADLINE_MS);
	const result = await collectModelClientGeneration(client, {
		promptPlan: promptPlanOf(prompt),
		modelId: memory.extractionModel,
		generationSettings: { temperature: null, topP: null, frequencyPenalty: null, presencePenalty: null, contextLimit: memory.contextLimit, responseBudget: memory.outputReserve, requestOverrides: {} },
		connection: connectionSnapshotOf(settings, profile),
		signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
	}, { onEvent: (event) => {
		if (event.type !== "content") return;
		collectedOutputBytes += encoder.encode(event.text).byteLength;
		if (collectedOutputBytes > MAX_OUTPUT_BYTES) throw new Error("Memory extraction output exceeded 64 KiB.");
	} }).catch((error: Error) => {
		throw deadline.aborted ? new Error("Memory extraction exceeded its 10-minute limit. Retry this source.") : error;
	});
	trace("Extraction response", { elapsed: seconds(startedAt), finishReason: result.finishReason, usage: JSON.stringify(result.usage), reasoning: result.reasoning, content: prettyJson(result.content) });
	if (result.finishReason !== "stop") throw new Error(result.finishReason === "length" ? "Memory extraction output was truncated. Retry after reducing the source or increasing its output reserve." : "Memory extraction did not finish successfully. Retry this source.");
	let parsed: MemoryExtractionResponse;
	try { parsed = Value.Parse(memoryExtractionResponse, JSON.parse(result.content)); } catch { throw new Error("Memory extraction returned malformed or invalid JSON. Retry this source."); }
	const { candidates, dropped } = validateMemoryCandidates(parsed, [source, ...retainedContext], source.messageId);
	trace("Validated candidates", { count: String(candidates.length), dropped: dropped.join("\n") || "none", candidates: JSON.stringify(candidates, null, 2) });
	return { candidates, context: retainedContext };
};

const isChoiceLabel = <const Labels extends readonly string[]>(labels: Labels, value: string): value is Labels[number] =>
	labels.some((label) => label === value);

const parseChoice = <const Labels extends readonly string[]>(answer: JevAnswer | undefined, labels: Labels) => {
	if (answer?.type !== "choice") throw new Error("Typesafe returned a missing or malformed Memory judgment.");
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
	if (!(answer.confidence >= 0 && answer.confidence <= 1)) throw new Error("Typesafe returned an invalid Memory judgment confidence.");
	return { label: selected, probabilities: normalized, confidence: answer.confidence };
};

const supportCriteria = {
	supported: "`source` states the claim or directly implies it",
	contradicted: "`source` states the opposite, or later negates or revises it",
	not_established: "`source` only suggests it, or frames it as a dream, rumor, quote, or uncertainty",
};
const attributionCriteria = {
	correct: "`source` shows `memory.attribution` holds the claim in the way described",
	misattributed: "The claim belongs to someone else in `source`, or it is said, heard, witnessed, or believed rather than as described",
	unclear: "`source` does not make clear who holds the claim",
};
const usefulnessCriteria = {
	retain: { what: "A lasting fact, relationship, promise, decision, change of state, or belief", not_for: "Description of the current moment" },
	omit: { what: "Sensory detail, scene description, momentary action, or mood", not_for: "Anything later scenes could need to stay consistent" },
};
const candidateQuestions = (candidate: MemoryCandidate) => ({
	support: { type: "choice", instructions: { memory: { claim: candidate.claim, evidence: candidate.evidence.map((item) => item.excerpt) }, question: "How does `source` relate to `memory.claim`?" }, criteria: supportCriteria },
	attribution: { type: "choice", instructions: { memory: { claim: candidate.claim, attribution: candidate.attribution }, question: "In `source`, is `memory.attribution` the one who narrates, says, witnesses, hears, or believes `memory.claim`?" }, criteria: attributionCriteria },
	usefulness: { type: "choice", instructions: { memory: { claim: candidate.claim, attribution: candidate.attribution }, question: "Will `memory.claim` still matter to the story after the scene in `source` ends?" }, criteria: usefulnessCriteria },
});

export async function judgeMemoryCandidates({ source, context, candidates, credential, model, fetch, signal, trace }: {
	source: CapturedMemoryMessage;
	context: readonly CapturedMemoryMessage[];
	candidates: readonly MemoryCandidate[];
	credential: string;
	model: string;
	fetch?: ModelFetch;
	signal?: AbortSignal;
	trace?: MemoryTrace;
}): Promise<MemoryCandidateJudgment[]> {
	if (candidates.length === 0) return [];
	if (!credential) throw new Error("Configure the Typesafe credential in Connections.");
	const output: MemoryCandidateJudgment[] = [];
	const state = { source, context };
	const batches = packJev(candidates.map((candidate, id) => ({ candidate, id })), (batch) => jevRequest(model, state, Object.fromEntries(batch.flatMap(({ candidate, id }) => Object.entries(candidateQuestions(candidate)).map(([name, question]) => [`candidate_${id}_${name}`, question])))), "Required Typesafe Memory evidence exceeds the bounded Jev request. No partial collection was saved.", 16);
	for (const { request, items } of batches) {
		const answers = await requestJev({ request, credential, fetch, signal, trace });
		for (const { candidate, id } of items) {
			const support = parseChoice(answers.get(`candidate_${id}_support`), ["supported", "contradicted", "not_established"] as const);
			const attribution = parseChoice(answers.get(`candidate_${id}_attribution`), ["correct", "misattributed", "unclear"] as const);
			const usefulness = parseChoice(answers.get(`candidate_${id}_usefulness`), ["retain", "omit"] as const);
			const prefixed = (name: string, probabilities: Record<string, number>) => Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [`${name}:${key}`, value]));
			output.push({ ...candidate, judgment: { support: support.label, attribution: attribution.label, usefulness: usefulness.label, confidence: { support: support.confidence, attribution: attribution.confidence, usefulness: usefulness.confidence }, probabilities: { ...prefixed("support", support.probabilities), ...prefixed("attribution", attribution.probabilities), ...prefixed("usefulness", usefulness.probabilities) } } });
		}
	}
	return output;
}

export async function extractAndJudgeMemorySource(database: Database, source: CapturedMemoryMessage, context: readonly CapturedMemoryMessage[], fetcher?: ModelFetch, signal?: AbortSignal, trace: MemoryTrace = noTrace): Promise<MemoryCandidateJudgment[]> {
	const settings = createMemorySettingsModule(database).get();
	const typesafe = createTypesafeSettingsModule(database);
	const jevModel = typesafe.get().jevModel;
	const extracted = await generatedContent(database, settings, source, context, fetcher, signal, trace);
	signal?.throwIfAborted();
	const judgments = await judgeMemoryCandidates({ source, context: extracted.context, candidates: extracted.candidates, credential: typesafe.getCredential() ?? "", model: jevModel, fetch: fetcher, signal, trace });
	const kept = judgments.filter(({ judgment }) => judgment.support === "supported" && judgment.attribution === "correct" && judgment.usefulness === "retain" && judgment.confidence.usefulness >= settings.usefulnessConfidenceGate);
	trace("Kept memories", { rule: `supported, correctly attributed, and retain with confidence >= ${settings.usefulnessConfidenceGate}`, kept: String(kept.length), dropped: String(judgments.length - kept.length), memories: JSON.stringify(kept, null, 2) });
	return kept;
}
