import type { PromptChannels } from "../../shared/contract/prompt-schema";
import type { PromptPresetSlot } from "../../shared/contract/prompt-preset";
import type {
	PromptHistoryRole,
} from "../../shared/contract/conversation-schema";
import type { AttemptEnvironment } from "../../shared/prompt-macro-engine";
import type { MemoryRecallCandidateRecord } from "../../shared/contract/memory-recall";

export type {
	AttemptEnvironment,
	MacroAttemptState,
	MacroEnvironment,
} from "../../shared/prompt-macro-engine";
export type {
	GenerationIntent,
	PromptBlock,
	PromptHistoryRole,
	PromptPlan,
	PromptWarning,
} from "../../shared/contract/conversation-schema";

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

/** A captured, already-admitted lore entry. Matching is owned by the lore domain. */
export interface PromptLoreEntry {
	readonly content: string;
	readonly always?: boolean;
	readonly priority?: number;
	readonly bookOrder?: number;
	readonly entryOrder?: number;
	/** Stable source identity retained for activation-budget evidence. */
	readonly bookId?: number;
	readonly entryId?: number;
}

// The authorship an entry carries into the provider request. Null means the
// entry's author matched neither controlled Participant and no captured
// historical pair claimed it — a preservation import, or a Participant
// displaced from a seat it once held.
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

export interface CompilePromptInput {
	human: CompilePromptDefinition;
	model: CompilePromptDefinition;
	context?: readonly PromptContextEntry[];
	// The selected Prompt Preset's ordered recipe. It decides which blocks the
	// plan contains and in what order; the compiler holds no order of its own.
	recipe: readonly PromptPresetSlot[];
	/** Captured lore selected by the generation workflow; rendered literally. */
	lore?: readonly PromptLoreEntry[];
	/** Captured and judged Memory candidates, already in recall order. */
	memory?: readonly MemoryRecallCandidateRecord[];
	// Captured once for one assembly. Environment and state are one invariant:
	// budget recompilation must reuse both or create both together.
	attempt?: AttemptEnvironment;
}
