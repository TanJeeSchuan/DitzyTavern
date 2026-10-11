import type { TSchema } from "@sinclair/typebox";
import type { requestDecisions } from "../decision-model";
import type { MemoryEmbeddingConfiguration } from "../memory/indexing";
import type { createModelClient } from "../model-client";

export interface BoxServices {
	readonly llm: (options: Omit<Parameters<typeof createModelClient>[0], "fetch">) => ReturnType<typeof createModelClient>;
	readonly decide: (input: Omit<Parameters<typeof requestDecisions>[0], "fetch" | "signal">) => ReturnType<typeof requestDecisions>;
	readonly embed: (text: string, configuration: MemoryEmbeddingConfiguration) => Promise<readonly (readonly number[])[]>;
}

export type BoxContext<Services extends keyof BoxServices = never> = Pick<BoxServices, Services> & { readonly signal: AbortSignal };

export interface Box<Setup, Dependencies = undefined, Trace = never, Services extends keyof BoxServices = never> {
	readonly inject?: readonly Services[];
	readonly setup?: { readonly schema: TSchema; readonly initial: Setup };
	readonly advance?: {
		readonly trace?: TSchema;
		run(input: AdvanceInput<Setup, Dependencies>, ctx: BoxContext<Services>): Promise<AdvanceResult<Trace>>;
		fingerprint?(input: AdvanceInput<Setup, Dependencies>): string;
	};
}

export type AdvanceInput<Setup, Dependencies = undefined> = { readonly setup: Setup; readonly dependencies: Dependencies };
export type AdvanceResult<Trace = never> = {
	readonly items: readonly BlockItem[];
	readonly allowance?: number;
	readonly trace?: Trace;
};

export type BlockItem = { readonly text: string; readonly priority: number; readonly pinned?: boolean };
export type BoxAdmission = "admitted" | "allowance" | "oversized" | "context-limit";
