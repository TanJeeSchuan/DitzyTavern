import { describe, expect, test } from "bun:test";
import { judgeMemoryCandidates, validateMemoryCandidates, type MemoryCandidate } from "./extraction";
import type { ModelFetch } from "../model-client";
import { Value } from "@sinclair/typebox/value";
import { memoryExtractionResponse } from "../../shared/contract/memory";

const source = { messageId: 10, variantId: 20, content: "Maren promised Writer the brass key." };
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
	test("sends independent support and usefulness questions with evidence and validates probabilities", async () => {
		let requestBody = "";
		let authorization = "";
		const fakeFetch: ModelFetch = async (_input, init) => {
			requestBody = String(init?.body);
			authorization = new Headers(init?.headers).get("authorization") ?? "";
			return Response.json({ answers: {
				candidate_0_support: { type: "choice", choice: "supported", probabilities: { supported: 0.8, contradicted: 0.1, not_established: 0.1 } },
				candidate_0_usefulness: { type: "choice", choice: "retain", probabilities: { retain: 0.9, omit: 0.1 } },
			} });
		};
		const [judgment] = await judgeMemoryCandidates([candidate], "secret", "jev-1.13.0", fakeFetch);
		// ==[HUMAN APPROVED]== SAFETY: The fake captures the request emitted by judgeMemoryCandidates, whose request shape is asserted below.
		const sent = JSON.parse(requestBody) as { state: { candidates: { id: number; attribution: string; evidence: { excerpt: string }[] }[] }; questions: Record<string, { instructions: string }> };
		expect(authorization).toBe("Bearer secret");
		expect(sent.state.candidates[0]).toMatchObject({ id: 0, attribution: candidate.attribution, evidence: candidate.evidence });
		expect(sent.questions.candidate_0_support.instructions).toContain(candidate.attribution);
		expect(sent.questions.candidate_0_support.instructions).toContain(candidate.evidence[0].excerpt);
		expect(sent.questions.candidate_0_usefulness.instructions).toContain(candidate.claim);
		expect(judgment?.judgment).toMatchObject({ support: "supported", usefulness: "retain", probabilities: { "support:supported": 0.8, "usefulness:retain": 0.9 } });
	});

	test("rejects incomplete judgment responses without producing a partial result", async () => {
		const fakeFetch: ModelFetch = async () => Response.json({ answers: {
			candidate_0_support: { type: "choice", choice: "supported", probabilities: { supported: 1, contradicted: 0, not_established: 0 } },
		} });
		await expect(judgeMemoryCandidates([candidate], "secret", "jev-1.13.0", fakeFetch)).rejects.toThrow("omitted or added required Memory judgments");
	});
});
