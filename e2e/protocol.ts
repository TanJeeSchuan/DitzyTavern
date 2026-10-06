import type { DecisionAnswer } from "../src/shared/contract/decision-model";

export type ChatReply =
	| { chunks: string[]; firstChunkDelayMs?: number; chunkDelayMs?: number; hold?: boolean; truncate?: boolean; repeat?: boolean }
	| { status: number; error: string; hold?: boolean; repeat?: boolean };

export type DecisionRule = { match: string[]; answer: DecisionAnswer } | { match: string[]; status: number };

export type MemoryClaim = { claim: string; attribution: string; people: string[]; excerpt: string };

export type ModelCall = { kind: string; url: string; headers: Record<string, string>; body: any };
