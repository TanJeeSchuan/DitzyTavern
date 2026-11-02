import type { MemorySourceView } from "./contract";

export type MemorySourceState = { kind: "remembered" | "empty" | "unprocessed" | "failed" | "skipped"; text: string; needsAttention: boolean };

const state = (kind: MemorySourceState["kind"], text: string): MemorySourceState => ({ kind, text, needsAttention: kind === "failed" });

export const memorySourceState = (source: MemorySourceView | undefined): MemorySourceState => {
	if (!source) return state("skipped", "Nothing to process");
	if (source.status.kind === "failed") return state("failed", "Needs attention");
	if (source.claims === null) return state("unprocessed", "Not remembered yet");
	if (source.claims.length === 0) return state("empty", "Nothing worth remembering");
	return state("remembered", `${source.claims.length} ${source.claims.length === 1 ? "Memory" : "Memories"}`);
};
