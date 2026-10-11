import type { TSchema } from "@sinclair/typebox";
import type { DecisionJson, DecisionQuestions, requestDecisions } from "../decision-model";
import type { MemoryEmbeddingConfiguration } from "../memory/indexing";
import type { createModelClient } from "../model-client";

export interface BoxServices {
	readonly llm: (options: Omit<Parameters<typeof createModelClient>[0], "fetch">) => ReturnType<typeof createModelClient>;
	readonly decide: (input: Omit<Parameters<typeof requestDecisions>[0], "fetch" | "signal">) => ReturnType<typeof requestDecisions>;
	readonly embed: (text: string, configuration: MemoryEmbeddingConfiguration) => Promise<readonly (readonly number[])[]>;
}

export type BoxContext<Services extends keyof BoxServices = never> = Pick<BoxServices, Services> & { readonly signal: AbortSignal };

export interface Box<Setup, Dependencies = undefined, Trace = never, Services extends keyof BoxServices = never, Rec = never, State = undefined, Move = never> {
	readonly inject?: readonly Services[];
	readonly setup?: { readonly schema: TSchema; readonly initial: Setup };
	/** @approved Moves the human attaches to a Message for this Box; history sent to the model shows each as `render`, given the Message's author. */
	readonly moves?: { readonly schema: TSchema; render(move: Move, author: string): string };
	readonly records?: {
		readonly schema: TSchema;
		readonly initial: State;
		fold(state: State, record: Rec): State;
		readonly digest?: { readonly window: number; run(window: DigestWindow, ctx: DigestContext): Promise<Rec> };
	};
	readonly advance?: {
		readonly trace?: TSchema;
		run(input: AdvanceInput<Setup, Dependencies, State, Move>, ctx: BoxContext<Services>): Promise<AdvanceResult<Trace, Rec>>;
		fingerprint?(input: AdvanceInput<Setup, Dependencies, State, Move>): string;
	};
	/** @approved The Box's one-line dock status, or null when it has nothing to say. */
	status?(setup: Setup, state: State): string | null;
}

/** @approved `moves` are the ones on the triggering Human-authored Message, in order; a Continuation has none. */
export type AdvanceInput<Setup, Dependencies = undefined, State = undefined, Move = never> = { readonly setup: Setup; readonly dependencies: Dependencies; readonly state: State; readonly moves: readonly Move[] };
export type AdvanceResult<Trace = never, Rec = never> = {
	readonly items: readonly BlockItem[];
	readonly allowance?: number;
	readonly trace?: Trace;
	readonly record?: Rec | undefined;
};

export type BlockItem = { readonly text: string; readonly priority: number; readonly pinned?: boolean };
export type BoxAdmission = "admitted" | "allowance" | "oversized" | "context-limit";

export type DigestPassage = { readonly speaker: string | null; readonly content: string };
/** @approved One selected passage, the `window` Messages before it, and the Box's seed stream for its Variant. */
export type DigestWindow = { readonly passage: DigestPassage; readonly preceding: readonly DigestPassage[]; readonly seed: string };
/** @approved A digest asks the Box's own Decision Model selection; the host packs and bounds the request. */
export type DigestContext = {
	readonly signal: AbortSignal;
	decide(state: DecisionJson, questions: DecisionQuestions): ReturnType<typeof requestDecisions>;
};
