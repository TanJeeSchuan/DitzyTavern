import type { TSchema } from "@sinclair/typebox";
import type { Database } from "bun:sqlite";
import type { BoxValue } from "../../shared/contract/box-value";
import type { GenerationJsonValue } from "../../shared/generation-json";
import type { DecisionJson, DecisionQuestions, requestDecisions } from "../decision-model";
import type { EmbeddingConfiguration } from "./embedding";

/** @approved One completion from a chat Connection Profile: `prompt` is the system message, `signal` adds a limit to the Box's own, and `onContent` sees each streamed chunk and may throw to stop it. */
export type BoxCompletion = {
	readonly model: string;
	readonly prompt: string;
	readonly contextLimit: number;
	readonly responseBudget: number;
	readonly signal?: AbortSignal;
	readonly onContent?: (text: string) => void;
};

export interface BoxServices {
	/** @approved The chat Connection Profile `profileId`, or undefined once it is gone. */
	readonly llm: (profileId: number) => { complete(request: BoxCompletion): Promise<{ readonly content: string; readonly finishReason: "stop" | "length" | "other" }> } | undefined;
	/** @approved Asks the Box's own Decision Model selection; throws without one, or when `state` exceeds its token limit. */
	readonly decide: (state: DecisionJson, questions: DecisionQuestions) => ReturnType<typeof requestDecisions>;
	/** @approved One vector per text, in one request. With `cache`, texts embedded before under the same model are read back instead. */
	readonly embed: (texts: readonly string[], configuration: EmbeddingConfiguration, options?: { readonly cache?: boolean }) => Promise<readonly (readonly number[])[]>;
}

export type BoxContext<Services extends keyof BoxServices = never> = Pick<BoxServices, Services> & { readonly signal: AbortSignal };

export interface Box<Setup, Dependencies = undefined, Trace = never, Services extends keyof BoxServices = never, Rec = never, State = undefined, Move = never> {
	readonly inject?: readonly Services[];
	/** @approved Rejects a setup its schema accepts but the Box does not, given the setup it replaces; the message is shown to the writer. */
	setupError?(setup: Setup, previous: Setup): string | undefined;
	/** @approved History sent to the model shows each of the Box's Moves as `render`, given the Message's author, or as its descriptor's chip label once the Box is not enabled. */
	readonly moves?: { render(move: Move, author: string): string };
	/** @approved What the Box needs beyond its setup, state and Moves, taken from what the host read for this Generation. */
	dependencies?(read: CaptureRead, setup: Setup): Dependencies;
	/** @approved How the records the descriptor's `record` schema describes fold into state, in Message order, from `initial`. */
	readonly records?: {
		readonly initial: State;
		fold(state: State, record: Rec, setup: Setup): State;
		readonly digest?: { readonly window: number; run(window: DigestWindow, ctx: DigestContext<Services>): Promise<Rec> };
	};
	readonly advance?: {
		readonly trace?: TSchema;
		run(input: AdvanceInput<Setup, Dependencies, State, Move>, ctx: BoxContext<Services>): Promise<AdvanceResult<Trace, Rec>>;
		fingerprint?(input: AdvanceInput<Setup, Dependencies, State, Move>): string;
	};
	/** @approved A digesting Box's one-line dock status, or null when it has nothing to say; the passage timeline read reports it. */
	status?(setup: Setup, state: State): string | null;
	/** @approved The setup a SillyTavern chat's Author's Note imports as; a Box without it ignores the note. */
	importSillyTavernNote?(note: string): Setup;
	/** @approved The window's data, served at `GET /api/conversations/:id/boxes/:box`, or undefined for a missing Chat. The client decodes it with the Box's shared read schema. A digesting Box declares none: the host serves its passage timeline. */
	read?(database: Database, conversationId: number): GenerationJsonValue | undefined;
}

// @approved
//  Any Box, as the host holds it: the host routes each value to the Box that
// produced it and never interprets it.
export type HostBox = Box<BoxValue, unknown, GenerationJsonValue, keyof BoxServices, GenerationJsonValue, unknown, unknown>;

/** @approved One selected Message as the model reads it: `content` renders its Moves before the prose, `prose` is the Variant's stored text. `role` is null for an author in neither seat. */
export type CaptureMessage = {
	readonly messageId: number;
	readonly variantId: number;
	readonly position: number;
	readonly authorId: number | null;
	readonly speaker: string | null;
	readonly role: "human" | "model" | null;
	readonly content: string;
	readonly prose: string;
};

/** @approved What the host read for one Generation, from which a Box takes its `dependencies`. A Box's `seed` is its own stream of the Variant's seed. `messages` is the Selected path; `pending` is the text a Send submits, Moves rendered, before it becomes a Message. `database` serves further reads, as `read` gets it. */
export type CaptureRead = {
	readonly database: Database;
	readonly conversationId: number;
	readonly seed: string;
	readonly intent: "respond" | "continue";
	readonly human: { readonly id: number; readonly name: string };
	readonly cast: readonly { readonly id: number; readonly name: string }[];
	readonly messages: readonly CaptureMessage[];
	readonly pending: string | undefined;
};

/** @approved `moves` are the ones on the triggering Human-authored Message, in order; a Continuation has none. */
export type AdvanceInput<Setup, Dependencies = undefined, State = undefined, Move = never> = { readonly setup: Setup; readonly dependencies: Dependencies; readonly state: State; readonly moves: readonly Move[] };
export type AdvanceResult<Trace = never, Rec = never> = {
	readonly items: readonly BlockItem[];
	readonly allowance?: number;
	readonly trace?: Trace;
	readonly record?: Rec | undefined;
};

/** @approved A `literal` item's text reaches the prompt as written, skipping the Prompt Macro pass. */
export type BlockItem = { readonly text: string; readonly priority: number; readonly pinned?: boolean; readonly literal?: boolean };

/** @approved `authorId` is the authoring Participant's id, null when the author is unknown. */
export type DigestPassage = { readonly messageId: number; readonly speaker: string | null; readonly authorId: number | null; readonly content: string };
/** @approved One selected passage, the `window` Messages before it, the Box's seed stream for its Variant, the Chat's Cast (removed Participants included, so every passage's author resolves) and the Box's own Chat-scoped `box:<id>` values by key, undecoded. */
export type DigestWindow = {
	readonly passage: DigestPassage;
	readonly preceding: readonly DigestPassage[];
	readonly seed: string;
	readonly cast: readonly { readonly id: number; readonly name: string; readonly removed: boolean }[];
	readonly data: Readonly<Record<string, string>>;
};
/** @approved A digest gets the services its Box injects, as `advance` does, and always `decide`. `database` serves the reads its window does not carry, as `read` gets it. */
export type DigestContext<Services extends keyof BoxServices = never> = BoxContext<Services | "decide"> & { readonly database: Database };
