import { describe, expect, test } from "bun:test";
import { judgeMemoryCandidates, judgeMemoryRecallCandidates, validateMemoryCandidates, type MemoryCandidate } from "./extraction";
import type { MemoryRecallCandidateRecord } from "../../shared/contract/memory-recall";
import type { ModelFetch } from "../model-client";
import { Value } from "@sinclair/typebox/value";
import { memoryExtractionResponse } from "../../shared/contract/memory";

const source = { messageId: 10, variantId: 20, content: "Maren promised Writer the brass key." };
const context = [{ messageId: 9, variantId: 19, content: "Writer asked Maren about the lodge key." }];
const candidate: MemoryCandidate = {
	claim: "Maren promised Writer the brass key.",
	attribution: "Narrated as an established event",
	people: ["Maren", "Writer"],
	evidence: [{ messageId: 10, excerpt: "Maren promised Writer the brass key." }],
};

describe("Memory extraction validation", () => {
	test("accepts exact selected-source evidence and suppresses duplicate claims", () => {
		const parsed = { candidates: [candidate, structuredClone(candidate)] };
		expect(validateMemoryCandidates(parsed, [source], source.messageId)).toEqual([candidate]);
	});

	test("rejects malformed candidates and excerpts that merely resemble captured text", () => {
		expect(() => validateMemoryCandidates({ candidates: [{ ...candidate, evidence: [{ messageId: 10, excerpt: "Maren promised Writer a brass key." }] }] }, [source], source.messageId)).toThrow("not exact captured source text");
		expect(() => validateMemoryCandidates({ candidates: [{ ...candidate, evidence: [] }] }, [source], source.messageId)).toThrow("one to three evidence excerpts");
		expect(Value.Check(memoryExtractionResponse, { candidates: [{ ...candidate, extra: true }] })).toBe(false);
	});
});

describe("Typesafe Memory judgments", () => {
	test("sends the source once in state and each candidate in its own support, attribution, and usefulness questions", async () => {
		let requestBody = "";
		let authorization = "";
		const fakeFetch: ModelFetch = async (_input, init) => {
			requestBody = String(init?.body);
			authorization = new Headers(init?.headers).get("authorization") ?? "";
			return Response.json({ answers: {
				candidate_0_support: { type: "choice", choice: "supported", probabilities: { supported: 0.8, contradicted: 0.1, not_established: 0.1 }, confidence: 0.7 },
				candidate_0_attribution: { type: "choice", choice: "correct", probabilities: { correct: 0.95, misattributed: 0.03, unclear: 0.02 }, confidence: 0.9 },
				candidate_0_usefulness: { type: "choice", choice: "retain", probabilities: { retain: 0.9, omit: 0.1 }, confidence: 0.8 },
			} });
		};
		const [judgment] = await judgeMemoryCandidates({ source, context }, [candidate], "secret", "jev-1.13.0", fakeFetch);
		// ==[HUMAN APPROVED]== SAFETY: The fake captures the request emitted by judgeMemoryCandidates, whose request shape is asserted below.
		const sent = JSON.parse(requestBody) as { state: { source: string; context: string[] }; questions: Record<string, { instructions: { memory: { claim: string; attribution?: string; evidence?: string[] } } }> };
		expect(authorization).toBe("Bearer secret");
		expect(sent.state).toEqual({ source: source.content, context: [context[0].content] });
		expect(sent.questions.candidate_0_support.instructions.memory).toEqual({ claim: candidate.claim, evidence: [candidate.evidence[0].excerpt] });
		expect(sent.questions.candidate_0_attribution.instructions.memory).toEqual({ claim: candidate.claim, attribution: candidate.attribution });
		expect(sent.questions.candidate_0_usefulness.instructions.memory).toEqual({ claim: candidate.claim, attribution: candidate.attribution });
		expect(judgment?.judgment).toMatchObject({ support: "supported", usefulness: "retain", probabilities: { "support:supported": 0.8, "usefulness:retain": 0.9 }, attribution: "correct", confidence: { support: 0.7, attribution: 0.9, usefulness: 0.8 } });
	});

	test("rejects incomplete judgment responses without producing a partial result", async () => {
		const fakeFetch: ModelFetch = async () => Response.json({ answers: {
			candidate_0_support: { type: "choice", choice: "supported", probabilities: { supported: 1, contradicted: 0, not_established: 0 }, confidence: 1 },
		} });
		await expect(judgeMemoryCandidates({ source, context }, [candidate], "secret", "jev-1.13.0", fakeFetch)).rejects.toThrow("omitted or added required answers");
	});

	test("labels recalled relevance from the same score that decides admission", async () => {
		const record: MemoryRecallCandidateRecord = { identity: "1:1:1:1:0", messageId: 1, variantId: 1, collectionRevision: 1, indexEpoch: 1, ownership: "automatic", sourceChanged: false, claimIndex: 0, claim: candidate.claim, attribution: candidate.attribution, people: [], evidence: candidate.evidence, sourcePosition: 1, semanticSimilarity: 0.5, semanticRank: 1, recentRank: null, judged: false, relevance: null, relevanceScore: null, retained: false, requestIncluded: false, admission: "request-limit" };
		const fakeFetch: ModelFetch = async () => Response.json({ answers: {
			"candidate_1:1:1:1:0_relevance": { type: "score", score: 1.56, legend: { 0: "Irrelevant", 1: "Incidental", 2: "Useful", 3: "Central" }, probabilities: { 0: 0.42, 1: 0, 2: 0.18, 3: 0.4 }, confidence: 0.1 },
		} });
		const [judged] = await judgeMemoryRecallCandidates([record], "Maren asks about the key.", 1.5, "secret", "jev-1.13.0", fakeFetch);
		expect(judged).toMatchObject({ relevance: "useful", relevanceScore: 1.56, retained: true, admission: "admitted" });
	});
});
