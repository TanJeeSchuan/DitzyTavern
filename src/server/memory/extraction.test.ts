import { describe, expect, test } from "bun:test";
import { judgeMemoryCandidates, validateMemoryCandidates } from "./extraction";
import { judgeMemoryRecallCandidates } from "./recall";
import type { MemoryRecallCandidateRecord } from "../../shared/contract/memory-recall";
import type { ModelFetch } from "../model-client";
import { Value } from "@sinclair/typebox/value";
import { memoryExtractionResponse } from "../../shared/contract/memory";
import type { CapturedMemoryMessage, MemoryCandidate } from "../../shared/contract/memory";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { createConnectionSettingsModule } from "../connection-settings";
import { createMemorySettingsModule } from "./settings";
import { configureDecisionModels } from "../contract/decision-model-test-fixtures";
import type { ResolvedDecisionModel } from "../decision-model";
const selection: ResolvedDecisionModel = { profileId: 1, profileName: "Decisions", model: "jev-1.13.0", stateTokenLimit: 16000, endpoint: "http://decision.test/v1/systemone", credential: "secret", headers: {}, timeoutMs: 15000 };
import { extractAndJudgeMemorySource } from "./extraction";

const source = { messageId: 10, variantId: 20, speaker: "Maren", content: "Maren promised Writer the brass key." };
const context = [{ messageId: 9, variantId: 19, speaker: "Writer", content: "Writer asked Maren about the lodge key." }];
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
		expect(Value.Check(memoryExtractionResponse, { candidates: [{ ...candidate, extra: true }] })).toBe(false);
	});
});

describe("Decision Model Memory judgments", () => {
	test("captures the Jev model before extraction suspends", async () => {
		const database: Database = openInitializedDatabase({ path: ":memory:" });
		const key = new Uint8Array(32).fill(11);
		initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.from(key).toString("base64") } });
		let releaseExtraction = () => {};
		let extractionStarted = () => {};
		const extractionGate = new Promise<void>((resolve) => { releaseExtraction = resolve; });
		const extractionRequest = new Promise<void>((resolve) => { extractionStarted = resolve; });
		let jevModel = "";
		try {
			const connections = createConnectionSettingsModule(database, { masterKey: key });
			const profileId = connections.createProfile({ expectedRevision: 0, profile: {
				displayName: "Extraction test",
				apiFormat: "chat-completions",
				requestUrl: "http://127.0.0.1:43131/v1/",
				modelsUrl: "",
				modelBackend: "automatic",
				adapter: "deepseek",
				outputTokenRepresentation: "automatic",
				timeoutMs: 120_000,
				pinnedModels: [],
			}, credential: "extraction-secret" }).profiles[0]?.id;
			if (profileId === undefined) throw new Error("Memory extraction fixture Connection Profile setup failed.");
			createMemorySettingsModule(database).apply({ expectedRevision: 0, enabled: true, extractionProfileId: profileId, extractionModel: "extract-model", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, retainProbabilityMinimum: 0.6, decisionProfileId: null, decisionModel: "", decisionStateTokenLimit: 16000, recallRelevanceMinimum: 1.5, embeddingProfileId: null, embeddingModel: "" });
			configureDecisionModels(database, key, "jev-before");
			const fakeFetch: ModelFetch = async (input, init) => {
				if (String(input).endsWith("/systemone")) {
					// SAFETY: requestJev serializes the Jev model as a string in the captured request body.
					jevModel = (JSON.parse(String(init?.body)) as { model: string }).model;
					return Response.json({ answers: {
						candidate_0_support: { type: "choice", choice: "supported", probabilities: { supported: 1, contradicted: 0, not_established: 0 }, confidence: 1 },
						candidate_0_attribution: { type: "choice", choice: "correct", probabilities: { correct: 1, misattributed: 0, unclear: 0 }, confidence: 1 },
						candidate_0_usefulness: { type: "choice", choice: "retain", probabilities: { retain: 1, omit: 0 }, confidence: 1 },
					} });
				}
				extractionStarted();
				await extractionGate;
				const content = JSON.stringify({ candidates: [{ claim: "Maren promised Writer the brass key.", attribution: "Narrated event", people: ["Maren", "Writer"], evidence: [{ messageId: source.messageId, excerpt: source.content }] }] });
				const stream = [
					{ choices: [{ index: 0, delta: { content }, finish_reason: null }] },
					{ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
				].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
				return new Response(stream, { headers: { "content-type": "text/event-stream" } });
			};
			const evaluation = extractAndJudgeMemorySource(database, source, context, fakeFetch);
			await extractionRequest;
			const memory = createMemorySettingsModule(database);
			const { revision, ...settings } = memory.get();
			memory.apply({ ...settings, expectedRevision: revision, decisionModel: "jev-after" });
			releaseExtraction();
			await evaluation;
			expect(jevModel).toBe("jev-before");
		} finally {
			releaseExtraction();
			database.close();
		}
	});

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
		const [judgment] = await judgeMemoryCandidates({ source, context, candidates: [candidate], selection, fetch: fakeFetch });
		// ==[HUMAN APPROVED]== SAFETY: The fake captures the request emitted by judgeMemoryCandidates, whose request shape is asserted below.
		const sent = JSON.parse(requestBody) as { state: { source: CapturedMemoryMessage; context: CapturedMemoryMessage[] }; questions: Record<string, { instructions: { memory: { claim: string; attribution?: string; evidence?: string[] } } }> };
		expect(authorization).toBe("Bearer secret");
		expect(sent.state).toEqual({ source, context });
		expect(sent.questions.candidate_0_support.instructions.memory).toEqual({ claim: candidate.claim, evidence: [candidate.evidence[0].excerpt] });
		expect(sent.questions.candidate_0_attribution.instructions.memory).toEqual({ claim: candidate.claim, attribution: candidate.attribution });
		expect(sent.questions.candidate_0_usefulness.instructions.memory).toEqual({ claim: candidate.claim, attribution: candidate.attribution });
		expect(judgment?.judgment).toMatchObject({ support: "supported", usefulness: "retain", probabilities: { "support:supported": 0.8, "usefulness:retain": 0.9 }, attribution: "correct", confidence: { support: 0.7, attribution: 0.9, usefulness: 0.8 } });
	});

	test("rejects incomplete judgment responses without producing a partial result", async () => {
		const fakeFetch: ModelFetch = async () => Response.json({ answers: {
			candidate_0_support: { type: "choice", choice: "supported", probabilities: { supported: 1, contradicted: 0, not_established: 0 }, confidence: 1 },
		} });
		await expect(judgeMemoryCandidates({ source, context, candidates: [candidate], selection, fetch: fakeFetch })).rejects.toThrow("omitted or added required answers");
	});

	test("labels recalled relevance from the same score that decides admission", async () => {
		const record: MemoryRecallCandidateRecord = { identity: "1:1:1:1:0", messageId: 1, variantId: 1, collectionRevision: 1, ownership: "automatic", sourceChanged: false, claimIndex: 0, claim: candidate.claim, attribution: candidate.attribution, people: [], evidence: candidate.evidence, sourcePosition: 1, semanticSimilarity: 0.5, semanticRank: 1, recentRank: null, relevance: null, relevanceScore: null, admission: "request-limit" };
		const fakeFetch: ModelFetch = async () => Response.json({ answers: {
			"candidate_1:1:1:1:0_relevance": { type: "score", score: 1.56, legend: { 0: "Irrelevant", 1: "Incidental", 2: "Useful", 3: "Central" }, probabilities: { 0: 0.42, 1: 0, 2: 0.18, 3: 0.4 }, confidence: 0.1 },
		} });
		const [judged] = await judgeMemoryRecallCandidates({ candidates: [record], scene: "Maren asks about the key.", relevanceMinimum: 1.5, selection, fetch: fakeFetch });
		expect(judged).toMatchObject({ relevance: "useful", relevanceScore: 1.56, admission: "admitted" });
	});
});
