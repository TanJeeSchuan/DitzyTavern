import type { GenerationJsonValue } from "../../shared/generation-json";
import { Value } from "@sinclair/typebox/value";
import { memoryActivationRecord, type MemoryActivationRecord } from "../../shared/contract/memory-recall";
import { renderMemoryClaim } from "../../shared/memory-text";
import type { AdvanceResult, BoxAdmission } from "./contract";

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
	}).map((candidate) => ({ text: renderMemoryClaim(candidate), priority: candidate.relevanceScore ?? -1 }));
	return {
		items,
		allowance: trace.allowance,
		trace: { ...trace, candidates: trace.candidates.map((candidate) => duplicates.has(candidate.identity) ? { ...candidate, admission: "duplicate-rendering" } : candidate) },
	};
};

export const memoryBudgetEvidence = (trace: GenerationJsonValue | undefined, decisions: ReadonlyMap<string, BoxAdmission>, text: string): MemoryActivationRecord | null => {
	if (trace === undefined) return null;
	const record = Value.Parse(memoryActivationRecord, trace);
	return {
		...record,
		candidates: record.candidates.map((candidate) => candidate.admission === "admitted" ? { ...candidate, admission: decisions.get(renderMemoryClaim(candidate)) ?? candidate.admission } : candidate),
		automaticMemoryText: record.automaticMemoryText || text,
		finalMemoryText: text,
	};
};
