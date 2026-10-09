import type { MemoryCollectionView } from "../../shared/contract/memory";

export type MemorySourceState = { kind: "remembered" | "empty" | "unprocessed" | "working" | "failed" | "skipped"; text: string; needsAttention: boolean };

const state = (kind: MemorySourceState["kind"], text: string): MemorySourceState => ({ kind, text, needsAttention: kind === "failed" });

export const memorySourceState = (source: MemoryCollectionView | undefined): MemorySourceState => {
	if (!source) return state("skipped", "Nothing to process");
	if (source.status === "unprocessed") return state("unprocessed", "Not remembered yet");
	if (source.status === "pending") return state("working", "Queued");
	if (source.status === "running") return state("working", "Remembering");
	if (source.status === "failed" || source.indexing.status === "failed" ||
		(source.status === "stale" && source.claims.length === 0)) return state("failed", source.status === "stale" ? "Source changed" : "Needs attention");
	if (source.claims.length === 0) return state("empty", "Nothing worth remembering");
	return state("remembered", `${source.claims.length} ${source.claims.length === 1 ? "Memory" : "Memories"}`);
};
