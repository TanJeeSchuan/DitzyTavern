import type { Static, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { decisionRequest, packDecisions, readBoxDecisionSettings, tokenxEstimator, type DecisionAnswer, type DigestContext, type DigestWindow } from "@/box-sdk/server";
import { projectImageAnchors } from "@/box-sdk/shared";
import { memoryChatSettings, memoryExtractionResponse, memoryLabels } from "./contract";
import type { CapturedMemoryMessage, MemoryCandidate, MemoryCandidateJudgment, MemoryExtractionResponse, MemoryRecord } from "./contract";
import { renderMemoryClaim } from "./shared";
import { createMemorySettingsModule, readMemoryEmbedding } from "./server-settings";

const MAX_EVIDENCE = 3;
const MAX_EXCERPT = 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const EXTRACTION_DEADLINE_MS = 10 * 60 * 1000;

/** @approved The digest's own `box:memory` values, decoded from the window. */
const chatValue = <T extends TSchema>(window: DigestWindow, key: string, schema: T, initial: Static<T>): Static<T> => {
	const stored = window.data[key];
	return stored === undefined ? initial : Value.Parse(schema, JSON.parse(stored));
};
const readLabels = (window: DigestWindow) => chatValue(window, "labels", memoryLabels, { identities: {}, merges: [] });

// @approved
//  Every name a Participant goes by in the window, its current name first,
//  so first-person and exclusion rules reach names it was captured under.
const castNames = (window: DigestWindow) => window.cast.map(({ id, name }) => ({
	id, names: [...new Set([name, ...[...window.preceding, window.passage].flatMap((message) => message.authorId === id && message.speaker !== null ? [message.speaker] : [])])],
}));

const identityInstructions = (window: DigestWindow, identities: Static<typeof memoryLabels>["identities"]) => castNames(window).flatMap(({ id, names }) => {
	const identity = identities[id];
	const [name, ...former] = names;
	if (identity?.kind === "excluded") return [`${name}${former.length ? ` (also ${former.join(", ")})` : ""} directs the story and is not a character in it. Never use ${names.join(" or ")} as a person.`];
	if (identity?.kind === "plays") return [`First person in ${name}'s${former.length ? ` (also ${former.map((name) => `${name}'s`).join(", ")})` : ""} Messages refers to ${identity.person}.`];
	return [];
}).join("\n");

const hasValidMemoryClaimText = (claim: string, attribution: string) =>
	claim.trim().length > 0 && attribution.trim().length > 0 && claim.length + attribution.length <= 1024;

const hasValidMemoryPeople = (people: readonly string[]) =>
	!people.some((person) => person.trim().length === 0) && new Set(people).size === people.length;

const candidateProblem = (
	candidate: MemoryExtractionResponse["candidates"][number],
	messages: ReadonlyMap<number, string>,
	sourceMessageId: number,
): string | null => {
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
		if (problem !== null) {
			dropped.push(`Memory candidate ${index + 1} ${problem}.`);
		} else {
			valid.push({
				claim: candidate.claim,
				attribution: candidate.attribution,
				people: candidate.people,
				evidence: candidate.evidence.map(({ messageId, excerpt }) => ({ messageId, excerpt })),
			});
		}
	}
	if (valid.length === 0 && dropped.length > 0) throw new Error(`Every Memory candidate was invalid. ${dropped.join(" ")}`);
	const unique = valid.filter((candidate, index) => valid.findIndex((other) => JSON.stringify(other) === JSON.stringify(candidate)) === index);
	return { candidates: unique, dropped };
}

const extractionInstructions = (sourceMessageId: number) => `Extract durable, attributed story Memories from the supplied selected source. Preceding messages are reference only. Each message's speaker is its captured author name, or null when unknown. Use that name to resolve first-person references when appropriate; an author can narrate or quote other people, so do not assume every claim concerns the author. Use consistent person names in people, not transport roles such as user or assistant unless those are actual names in the story. Preserve uncertainty, negation, attribution, hearing and witnessing. Do not turn out-of-character directions into story facts. Return exactly one JSON object: {"candidates":[{"claim":"...","attribution":"...","people":["..."],"evidence":[{"messageId":1,"excerpt":"exact source text"}]}]}. Return at most 16 candidates. Each candidate must cite at least one exact excerpt from owning source message ${sourceMessageId}; cite only supplied message IDs; use one to three excerpts, each at most 1024 characters. Claim plus attribution may total at most 1024 characters. Empty candidates are valid. Do not use Markdown.`;

// @approved
//  The oldest preceding Messages are dropped until the prompt fits the
//  extraction context and the passage with what remains fits `fitsDecision`,
//  the Decision Model's state limit; a passage that fits neither alone fails
//  before any request.
const extractCandidates = async (
	ctx: DigestContext,
	window: DigestWindow,
	source: CapturedMemoryMessage,
	context: readonly CapturedMemoryMessage[],
	fitsDecision: (retained: readonly CapturedMemoryMessage[]) => boolean,
) => {
	const memory = createMemorySettingsModule(ctx.database).get();
	if (tokenxEstimator(source.content) > 12_000) throw new Error("This complete source exceeds the 12,000-token Memory extraction limit. It was not truncated.");
	if (memory.extractionProfileId === null || memory.extractionModel.length === 0) throw new Error("Choose an extraction Connection Profile and model in Memory Settings.");
	const model = ctx.llm(memory.extractionProfileId);
	if (model === undefined) throw new Error("The selected Memory extraction Connection Profile is unavailable. Choose an available profile in Memory Settings.");
	const instructions = extractionInstructions(source.messageId);
	const identities = identityInstructions(window, readLabels(window).identities);
	const { note } = chatValue(window, "settings", memoryChatSettings, { allowance: 0, note: "" });
	const guidance = note ? `Chat note (guidance only, never a source of facts):\n${note}` : "";
	const promptOf = (retained: readonly CapturedMemoryMessage[]) =>
		`${instructions}${identities ? `\n${identities}` : ""}${guidance ? `\n\n${guidance}` : ""}\n\nCaptured source and reference context:\n${JSON.stringify({ source, precedingSelectedMessages: retained })}`;
	const exceedsContext = (retained: readonly CapturedMemoryMessage[]) => tokenxEstimator(promptOf(retained)) + memory.outputReserve + memory.safetyAllowance > memory.contextLimit;
	const retainedContext = [...context];
	while (retainedContext.length > 0 && (tokenxEstimator(JSON.stringify(retainedContext)) > 2_048 || exceedsContext(retainedContext) || !fitsDecision(retainedContext))) {
		retainedContext.shift();
	}
	if (exceedsContext(retainedContext)) throw new Error("The complete source and extraction instructions exceed the configured Memory extraction context. Raise the extraction context limit or shorten the source.");
	if (!fitsDecision(retainedContext)) throw new Error("The Memory source exceeds the Decision Model state token limit.");
	const encoder = new TextEncoder();
	let collectedOutputBytes = 0;
	const deadline = AbortSignal.timeout(EXTRACTION_DEADLINE_MS);
	const result = await model.complete({
		model: memory.extractionModel,
		prompt: promptOf(retainedContext),
		contextLimit: memory.contextLimit,
		responseBudget: memory.outputReserve,
		signal: deadline,
		onContent: (text) => {
			collectedOutputBytes += encoder.encode(text).byteLength;
			if (collectedOutputBytes > MAX_OUTPUT_BYTES) throw new Error("Memory extraction output exceeded 64 KiB.");
		},
	}).catch((error: Error) => {
		throw deadline.aborted ? new Error("Memory extraction exceeded its 10-minute limit. Retry this source.") : error;
	});
	if (result.finishReason !== "stop") {
		throw new Error(
			result.finishReason === "length"
				? "Memory extraction output was truncated. Retry after reducing the source or increasing its output reserve."
				: "Memory extraction did not finish successfully. Retry this source.",
		);
	}
	let parsed: MemoryExtractionResponse;
	try { parsed = Value.Parse(memoryExtractionResponse, JSON.parse(result.content)); } catch {
		throw new Error("Memory extraction returned malformed or invalid JSON. Retry this source.");
	}
	return { candidates: validateMemoryCandidates(parsed, [source, ...retainedContext], source.messageId).candidates, context: retainedContext, settings: memory };
};

const isChoiceLabel = <const Labels extends readonly string[]>(labels: Labels, value: string): value is Labels[number] =>
	labels.some((label) => label === value);

const parseChoice = <const Labels extends readonly string[]>(answer: DecisionAnswer | undefined, labels: Labels) => {
	if (answer?.type !== "choice" || !isChoiceLabel(labels, answer.choice)) throw new Error("Decision Model returned a missing or malformed Memory judgment.");
	return { label: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
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
	support: {
		type: "choice",
		instructions: { memory: { claim: candidate.claim, evidence: candidate.evidence.map((item) => item.excerpt) }, question: "How does `source` relate to `memory.claim`?" },
		criteria: supportCriteria,
	},
	attribution: {
		type: "choice",
		instructions: { memory: { claim: candidate.claim, attribution: candidate.attribution }, question: "In `source`, is `memory.attribution` the one who narrates, says, witnesses, hears, or believes `memory.claim`?" },
		criteria: attributionCriteria,
	},
	usefulness: {
		type: "choice",
		instructions: { memory: { claim: candidate.claim, attribution: candidate.attribution }, question: "Will `memory.claim` still matter to the story after the scene in `source` ends?" },
		criteria: usefulnessCriteria,
	},
});

// @approved
//  Candidates are judged in as few Decision Model requests as fit Memory's
//  selection, at most 16 candidates each.
export async function judgeMemoryCandidates({ source, context, candidates, selection, decide }: {
	source: CapturedMemoryMessage;
	context: readonly CapturedMemoryMessage[];
	candidates: readonly MemoryCandidate[];
	selection: { readonly model: string; readonly stateTokenLimit: number };
	decide: DigestContext["decide"];
}): Promise<MemoryCandidateJudgment[]> {
	if (candidates.length === 0) return [];
	const output: MemoryCandidateJudgment[] = [];
	const state = { source, context };
	const batches = packDecisions(
		candidates.map((candidate, id) => ({ candidate, id })),
		(batch) => decisionRequest(selection, state, Object.fromEntries(
			batch.flatMap(({ candidate, id }) => Object.entries(candidateQuestions(candidate)).map(([name, question]) => [`candidate_${id}_${name}`, question])),
		)),
		"Required Memory evidence exceeds the bounded Decision Model request.",
		16,
	);
	for (const { questions, items } of batches) {
		const answers = await decide(state, questions);
		for (const { candidate, id } of items) {
			const support = parseChoice(answers.get(`candidate_${id}_support`), ["supported", "contradicted", "not_established"] as const);
			const attribution = parseChoice(answers.get(`candidate_${id}_attribution`), ["correct", "misattributed", "unclear"] as const);
			const usefulness = parseChoice(answers.get(`candidate_${id}_usefulness`), ["retain", "omit"] as const);
			const prefixed = (name: string, probabilities: Record<string, number>) =>
				Object.fromEntries(Object.entries(probabilities).map(([key, value]) => [`${name}:${key}`, value]));
			const confidence: MemoryCandidateJudgment["judgment"]["confidence"] = {};
			if (support.confidence !== undefined) confidence.support = support.confidence;
			if (attribution.confidence !== undefined) confidence.attribution = attribution.confidence;
			if (usefulness.confidence !== undefined) confidence.usefulness = usefulness.confidence;
			output.push({
				...candidate,
				judgment: {
					support: support.label,
					attribution: attribution.label,
					usefulness: usefulness.label,
					confidence,
					probabilities: {
						...prefixed("support", support.probabilities),
						...prefixed("attribution", attribution.probabilities),
						...prefixed("usefulness", usefulness.probabilities),
					},
				},
			});
		}
	}
	return output;
}

const captured = ({ messageId, speaker, content }: DigestWindow["passage"]): CapturedMemoryMessage => ({ messageId, speaker, content: projectImageAnchors(content) });

// @approved
//  Memory's digest: extract candidates from one passage, keep the ones the
// Decision Model judges supported, correctly attributed and worth retaining,
// and embed what it kept. A passage by an author who is not in the story
// holds no Memories.
export async function digestMemory(window: DigestWindow, ctx: DigestContext): Promise<MemoryRecord> {
	const author = window.passage.authorId;
	if (author !== null && readLabels(window).identities[author]?.kind === "excluded") return { claims: [] };
	const source = captured(window.passage);
	const context = window.preceding.map(captured);
	const { decisionModel, decisionStateTokenLimit } = readBoxDecisionSettings(ctx.database, "memory");
	const selection = { model: decisionModel, stateTokenLimit: decisionStateTokenLimit };
	const extracted = await extractCandidates(ctx, window, source, context, (retained) => tokenxEstimator(JSON.stringify({ source, context: retained })) <= selection.stateTokenLimit);
	ctx.signal.throwIfAborted();
	const judgments = await judgeMemoryCandidates({ source, context: extracted.context, candidates: extracted.candidates, selection, decide: ctx.decide });
	const claims = judgments.filter(({ judgment }) => {
		const retain = judgment.probabilities["usefulness:retain"];
		return judgment.support === "supported" && judgment.attribution === "correct" && judgment.usefulness === "retain"
			&& retain !== undefined && retain >= extracted.settings.retainProbabilityMinimum;
	});
	const embedding = readMemoryEmbedding(ctx.database);
	if (embedding.spaceKey !== "" && claims.length > 0) await ctx.embed(claims.map(renderMemoryClaim), embedding, { cache: true });
	return { claims };
}
