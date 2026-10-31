import type { AdvanceResult } from "@/box-sdk/server";
import type { MemoryActivationRecord } from "./contract";
import type { RecallActivation } from "./server-recall";
import { compareMemoryCandidates, renderMemoryClaim } from "./shared";

export const memoryItems = (trace: RecallActivation): AdvanceResult<MemoryActivationRecord> => {
	const seen = new Set<string>();
	const candidates = [...trace.candidates].sort(compareMemoryCandidates);
	const duplicates = new Set<string>();
	const items = candidates.filter((candidate) => {
		if (candidate.admission === "request-limit" || candidate.admission === "not-retained") return false;
		const text = renderMemoryClaim(candidate);
		if (seen.has(text)) { duplicates.add(candidate.identity); return false; }
		seen.add(text);
		return true;
	}).map((candidate) => ({ text: renderMemoryClaim(candidate), priority: candidate.relevanceScore ?? -1, literal: true }));
	return {
		items,
		allowance: trace.allowance,
		trace: { ...trace, candidates: trace.candidates.map(({ claim: _claim, attribution: _attribution, ...candidate }) => duplicates.has(candidate.identity) ? { ...candidate, admission: "duplicate-rendering" } : candidate) },
	};
};
