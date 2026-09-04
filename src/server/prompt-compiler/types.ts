import type { PromptChannels } from "../../shared/contract/prompt-schema";

// Provider-neutral Prompt Compiler contract. This module is pure: it never
// touches SQLite, HTTP, credentials, or provider vocabulary. It consumes
// resolved Participant Definitions and normalized selected history and
// produces a deterministic, named-block Prompt Plan plus macro warnings.

// A Definition as the compiler consumes it. The Prompt is the canonical
// shared contract, so callers pass Conversation-local and library
// Definitions through without translation while the compiler stays
// independent of both seams.
export interface CompilePromptDefinition {
	name: string;
	prompt: PromptChannels;
}

// The authorship an entry carries into the provider request. Null means the
// entry's author matched neither controlled Participant and no captured
// historical pair claimed it — a preservation import, or a Participant
// displaced from a seat it once held.
export type PromptHistoryRole = "human" | "model" | null;

// One entry of the ordered writing context. Every entry carries its own role,
// so nothing has to align a second list against this one and an entry may be
// inserted at any position without disturbing the entries around it.
//
// The `message` variant is derived from a Message's selected Variant; its
// speaker name comes from the immutable Author Stamp and is null for
// preservation records without resolved authorship. Its text is already-final
// output and is never macro-expanded. The kind discriminant exists so a later
// non-Message entry becomes a new variant rather than a new coupling.
export type PromptContextEntry = {
	kind: "message";
	speakerName: string | null;
	content: string;
	role: PromptHistoryRole;
};

// Provider-neutral purpose of one Generation attempt. A continuation is
// represented as intent metadata rather than a synthetic history Message;
// adapters may use the instruction to shape their request while the selected
// Conversation path remains unchanged.
export type GenerationIntent =
	| { type: "sibling" }
	| { type: "continuation"; strategy: "instruction"; instruction: string }
	| { type: "continuation"; strategy: "assistant-prefill"; suffix: "" | " " | "\n" | "\n\n" };

export interface CompilePromptInput {
	human: CompilePromptDefinition;
	model: CompilePromptDefinition;
	context?: readonly PromptContextEntry[];
}

// Named, ordered, provider-neutral blocks. The plan keeps blocks separate so
// a future Prompt Manager can reposition them without changing storage;
// no vendor role names appear here.
export type PromptBlock =
	| { kind: "system-instruction"; content: string }
	| { kind: "identity"; role: "human" | "model"; content: string }
	| { kind: "scenario"; content: string }
	| { kind: "example-dialogue"; content: string }
	| { kind: "history"; speakerName: string | null; content: string; role: PromptHistoryRole }
	| { kind: "post-history-instruction"; content: string };

// A preserved unknown macro surfaced by prompt inspection. The block label
// identifies where the macro appeared; the macro is the exact written text.
export interface PromptWarning {
	block: string;
	macro: string;
}

export interface PromptPlan {
	blocks: readonly PromptBlock[];
	warnings: readonly PromptWarning[];
	// Omitted for ordinary Tail and Sibling attempts. Continuation workflows
	// attach this exact editable instruction without adding history.
	intent?: GenerationIntent;
}

// Owner-relative macro context. `self` is the name of the Participant whose
// Definition (or opening) is being compiled; `other` is the name of the other
// controlled Participant.
export interface MacroContext {
	self: string;
	other: string;
}

export interface ExpansionResult {
	text: string;
	warnings: readonly PromptWarning[];
}
