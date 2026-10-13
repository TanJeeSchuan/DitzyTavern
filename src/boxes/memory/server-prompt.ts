import type { AdvanceResult } from "../../box-sdk/server";
import type { MemoryActivationRecord } from "./contract";
import { renderMemoryClaim } from "./shared";

export const memoryItems = (trace: MemoryActivationRecord): AdvanceResult<MemoryActivationRecord> => {
	const seen = new Set<string>();
	const candidates = [...trace.candidates].sort((left, right) =>
		(right.relevanceScore ?? -1) - (left.relevanceScore ?? -1) || right.sourcePosition - left.sourcePosition || left.identity.localeCompare(right.identity));
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
		trace: { ...trace, candidates: trace.candidates.map((candidate) => duplicates.has(candidate.identity) ? { ...candidate, admission: "duplicate-rendering" } : candidate) },
	};
};
