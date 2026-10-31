import type { RecallCandidate } from "./server-recall";
import { describe, expect, test } from "bun:test";
import { judgeMemoryCandidates, validateMemoryCandidates } from "./server-extraction";
import { judgeMemoryRecallCandidates } from "./server-recall";
import type { MemoryCandidate } from "./contract";
import type { DecisionAnswer } from "../../shared/contract/decision-model";
import type { DecisionQuestions } from "../../server/decision-model";

const selection = { model: "jev-1.13.0", stateTokenLimit: 16000 };

const source = { messageId: 10, speaker: "Maren", content: "Maren promised Writer the brass key." };
const context = [{ messageId: 9, speaker: "Writer", content: "Writer asked Maren about the lodge key." }];
const candidate: MemoryCandidate = {
	claim: "Maren promised Writer the brass key.",
	attribution: "Narrated as an established event",
	people: ["Maren", "Writer"],
	evidence: [{ messageId: 10, excerpt: "Maren promised Writer the brass key." }],
};

describe("Memory extraction validation", () => {
	test("accepts exact selected-source evidence and suppresses duplicate claims", () => {
		const parsed = { candidates: [candidate, structuredClone(candidate)] };
		expect(validateMemoryCandidates(parsed, [source], source.messageId)).toEqual({ candidates: [candidate], dropped: [] });
	});

	test("drops individual invalid candidates and keeps the valid ones", () => {
		const inexact = { ...candidate, claim: "Maren gave Writer a key.", evidence: [{ messageId: 10, excerpt: "Maren promised Writer a brass key." }] };
		expect(validateMemoryCandidates({ candidates: [inexact, candidate] }, [source], source.messageId)).toEqual({
			candidates: [candidate],
			dropped: ["Memory candidate 1 cites an excerpt that is not exact captured source text."],
		});
	});

	test("fails when every candidate is invalid", () => {
		expect(() => validateMemoryCandidates({ candidates: [{ ...candidate, evidence: [{ messageId: 10, excerpt: "Maren promised Writer a brass key." }] }] }, [source], source.messageId)).toThrow("not exact captured source text");
		expect(() => validateMemoryCandidates({ candidates: [{ ...candidate, evidence: [] }] }, [source], source.messageId)).toThrow("one to three evidence excerpts");
	});
});

describe("Decision Model Memory judgments", () => {
	const answers = (entries: Record<string, DecisionAnswer>) => new Map(Object.entries(entries));
	const supported = {
		candidate_0_support: { type: "choice", choice: "supported", probabilities: { supported: 0.8, contradicted: 0.1, not_established: 0.1 }, confidence: 0.7 },
		candidate_0_attribution: { type: "choice", choice: "correct", probabilities: { correct: 0.95, misattributed: 0.03, unclear: 0.02 }, confidence: 0.9 },
		candidate_0_usefulness: { type: "choice", choice: "retain", probabilities: { retain: 0.9, omit: 0.1 }, confidence: 0.8 },
	} satisfies Record<string, DecisionAnswer>;

	test("sends the source once in state and each candidate in its own support, attribution, and usefulness questions", async () => {
		const sent: { state: unknown; questions: DecisionQuestions }[] = [];
		const [judgment] = await judgeMemoryCandidates({ source, context, candidates: [candidate], selection, decide: async (state, questions) => { sent.push({ state, questions }); return answers(supported); } });
		expect(sent).toHaveLength(1);
		expect(sent[0]!.state).toEqual({ source, context });
		expect(sent[0]!.questions.candidate_0_support?.instructions).toMatchObject({ memory: { claim: candidate.claim, evidence: [candidate.evidence[0]!.excerpt] } });
		expect(sent[0]!.questions.candidate_0_attribution?.instructions).toMatchObject({ memory: { claim: candidate.claim, attribution: candidate.attribution } });
		expect(sent[0]!.questions.candidate_0_usefulness?.instructions).toMatchObject({ memory: { claim: candidate.claim, attribution: candidate.attribution } });
		expect(judgment?.judgment).toMatchObject({ support: "supported", usefulness: "retain", probabilities: { "support:supported": 0.8, "usefulness:retain": 0.9 }, attribution: "correct", confidence: { support: 0.7, attribution: 0.9, usefulness: 0.8 } });
	});

	test("rejects incomplete judgment responses without producing a partial result", async () => {
		const decide = async () => answers({ candidate_0_support: supported.candidate_0_support });
		await expect(judgeMemoryCandidates({ source, context, candidates: [candidate], selection, decide })).rejects.toThrow("missing or malformed Memory judgment");
	});

	test("labels recalled relevance from the same score that decides admission", async () => {
		const record: RecallCandidate = { identity: "1:1:0:ab", messageId: 1, variantId: 1, writer: false, sourceChanged: false, claimIndex: 0, claim: candidate.claim, attribution: candidate.attribution, sourcePosition: 1, semanticSimilarity: 0.5, semanticRank: 1, recentRank: null, relevance: null, relevanceScore: null, admission: "request-limit" };
		const decide = async () => answers({
			"candidate_1:1:0:ab_relevance": { type: "score", score: 1.56, legend: { 0: "Irrelevant", 1: "Incidental", 2: "Useful", 3: "Central" }, probabilities: { 0: 0.42, 1: 0, 2: 0.18, 3: 0.4 }, confidence: 0.1 },
		});
		const [judged] = await judgeMemoryRecallCandidates({ candidates: [record], scene: "Maren asks about the key.", relevanceMinimum: 1.5, selection, decide });
		expect(judged).toMatchObject({ relevance: "useful", relevanceScore: 1.56, admission: "admitted" });
	});
});
