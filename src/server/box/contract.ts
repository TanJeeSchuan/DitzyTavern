import type { TSchema } from "@sinclair/typebox";

// @approved
//  A Box is a compiled-in story feature with opaque state and optional hooks
// (ADR-0050). The host stores and routes its data and never interprets it.
export interface Box<Setup> {
	readonly setup?: { readonly schema: TSchema; readonly initial: Setup };
	readonly advance?: { run(input: AdvanceInput<Setup>): AdvanceResult };
}

export type AdvanceInput<Setup> = { readonly setup: Setup };
export type AdvanceResult = { readonly items: readonly BlockItem[] };

// @approved
//  Every item is pinned: it is admitted whole into the Box's block, counts
// toward the prompt total, and an over-budget plan is refused rather than
// trimmed.
export type BlockItem = { readonly text: string };
