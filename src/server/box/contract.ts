import type { TSchema } from "@sinclair/typebox";
import type { Database } from "bun:sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { AnyElysia } from "elysia";
import type { BoxValue } from "../../shared/contract/box-value";
import type { GenerationJsonValue } from "../../shared/generation-json";
import type { ConversationSummary, SelectedHistoryRead } from "../conversation";
import type { DecisionJson, DecisionQuestions, requestDecisions } from "../decision-model";
import type { RecordSlot } from "./records";
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

/** @approved What `advance.run` and `digest.run` receive, the same for every Box: each host service, and `signal`, which aborts when the server shuts down or, in a digest, when the job is superseded or cancelled. */
export interface BoxContext {
	/** @approved The chat Connection Profile `profileId`, or undefined once it is gone. */
	readonly llm: (profileId: number) => { complete(request: BoxCompletion): Promise<{ readonly content: string; readonly finishReason: "stop" | "length" | "other" }> } | undefined;
	/** @approved Asks the Box's own Decision Model selection; throws without one, or when `state` exceeds its token limit. */
	readonly decide: (state: DecisionJson, questions: DecisionQuestions) => ReturnType<typeof requestDecisions>;
	/** @approved One vector per text, in one request. With `cache`, texts embedded before under the same model are read back instead. */
	readonly embed: (texts: readonly string[], configuration: EmbeddingConfiguration, options?: { readonly cache?: boolean }) => Promise<readonly Float32Array[]>;
	readonly signal: AbortSignal;
}

export interface Box<Setup, Dependencies = undefined, Trace extends GenerationJsonValue = never, Rec extends GenerationJsonValue = never, State extends GenerationJsonValue | undefined = undefined, Move = never> {
	/** @approved Rejects a setup its schema accepts but the Box does not, given the setup it replaces; the message is shown to the writer. */
	setupError?(setup: Setup, previous: Setup): string | undefined;
	/** @approved History sent to the model shows each of the Box's Moves as `render`, given the Message's author, or as its descriptor's chip label once the Box is not enabled. */
	readonly moves?: { render(move: Move, author: string): string };
	/** @approved What the Box needs beyond its setup, state and Moves, taken from what the host read for this Generation, its own record slots included. */
	dependencies?(read: CaptureRead<Rec>, setup: Setup): Dependencies;
	/** @approved How the records the descriptor's `record` schema describes fold into state, in Message order, from `initial`. A Box without a fold has undefined state. */
	readonly records?: ({ readonly initial: State; fold(state: State, record: Rec, setup: Setup): State } | { readonly initial?: undefined; readonly fold?: undefined }) & {
		readonly digest?: { readonly window: number; run(window: DigestWindow, ctx: DigestContext): Promise<Rec> };
	};
	readonly advance?: {
		readonly trace?: TSchema;
		run(input: AdvanceInput<Setup, Dependencies, State, Move>, ctx: BoxContext): Promise<AdvanceResult<Trace, Rec>>;
		fingerprint?(input: AdvanceInput<Setup, Dependencies, State, Move>): string;
	};
	/** @approved A digesting Box's one-line dock status, or null when it has nothing to say; the passage timeline read reports it. */
	status?(setup: Setup, state: State): string | null;
	/** @approved The setup a SillyTavern chat's Author's Note imports as; a Box without it ignores the note. */
	importSillyTavernNote?(note: string): NonNullable<Setup>;
	/** @approved The window's data, served at `GET /api/conversations/:id/boxes/:box`; the host answers a missing Chat with 404. The client decodes it with the Box's shared read schema. A digesting Box declares none: the host serves its passage timeline. */
	read?(read: BoxWindowRead<Setup, State>): GenerationJsonValue;
	/** @approved Routes the Box serves beside the host's, which the host mounts under `/api/boxes/<id>`. Its client reaches them through `boxApi`. */
	routes?(database: Database): AnyElysia;
}

// @approved
//  Any Box, as the host holds it: the host routes each value to the Box that
// produced it and never interprets it. A Box without a setup gets undefined.
export type HostBox = Box<BoxValue | undefined, unknown, GenerationJsonValue, GenerationJsonValue, GenerationJsonValue | undefined, unknown>;

/** @approved What a Box's window `read` gets, read in one host transaction: `db` for further reads, the Chat's summary and Selected path, the Box's setup, and its fold over the Selected path's effective records, as Generation capture folds it. */
export type BoxWindowRead<Setup, State> = {
	readonly db: BunSQLiteDatabase;
	readonly conversationId: number;
	readonly summary: ConversationSummary;
	readonly history: SelectedHistoryRead;
	readonly setup: Setup;
	readonly state: State;
};

/** @approved One selected Message as the model reads it: `content` renders its Moves before the prose, `prose` is the Variant's stored text. `role` is null for an author in neither seat. `slot` is the Box's own record slot on the Variant. */
export type CaptureMessage<Rec = never> = {
	readonly messageId: number;
	readonly variantId: number;
	readonly position: number;
	readonly authorId: number | null;
	readonly speaker: string | null;
	readonly role: "human" | "model" | null;
	readonly content: string;
	readonly prose: string;
	readonly slot: RecordSlot<Rec> | undefined;
};

/** @approved What the host read for one Generation, from which a Box takes its `dependencies`. A Box's `seed` is its own stream of the Variant's seed. `messages` is the Selected path; `pending` is the text a Send submits, Moves rendered, before it becomes a Message. `database` serves further reads inside the capture's read transaction. */
export type CaptureRead<Rec = never> = {
	readonly database: Database;
	readonly conversationId: number;
	readonly seed: string;
	readonly intent: "respond" | "continue";
	readonly human: { readonly id: number; readonly name: string };
	readonly cast: readonly { readonly id: number; readonly name: string }[];
	readonly messages: readonly CaptureMessage<Rec>[];
	readonly pending: string | undefined;
};

/** @approved `moves` are the ones on the triggering Human-authored Message, in order; a Continuation has none. */
export type AdvanceInput<Setup, Dependencies = undefined, State extends GenerationJsonValue | undefined = GenerationJsonValue | undefined, Move = never> = { readonly setup: Setup; readonly dependencies: Dependencies; readonly state: State; readonly moves: readonly Move[] };
export type AdvanceResult<Trace extends GenerationJsonValue = never, Rec extends GenerationJsonValue = never> = {
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
/** @approved A digest gets the context `advance` gets, and `database` for the reads its window does not carry. */
export type DigestContext = BoxContext & { readonly database: Database };
