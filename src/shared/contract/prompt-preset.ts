import { Type, type Static } from "@sinclair/typebox";
import { notRemovableOutcome } from "./outcomes";
import { numericWire } from "./wire";

export type SillyTavernJsonValue =
	| null
	| boolean
	| number
	| string
	| SillyTavernJsonValue[]
	| { [key: string]: SillyTavernJsonValue };

// ==[HUMAN APPROVED]== A Referenced Prompt Block names Conversation or Participant Definition
// content rather than text authored in the preset. Version one's vocabulary
// is exactly the content the native five-field Prompt model and the selected
// narrative path can supply; the owner prefix states which controlled
// Participant's Definition supplies the slot.
const referencedDefinitionBlocks = [
	Type.Literal("model-system-instruction"),
	Type.Literal("human-identity"),
	Type.Literal("model-identity"),
	Type.Literal("model-scenario"),
	Type.Literal("model-example-dialogue"),
	Type.Literal("model-post-history-instruction"),
] as const;

export const referencedDefinitionBlock = Type.Union([...referencedDefinitionBlocks]);
export type ReferencedDefinitionBlock = Static<typeof referencedDefinitionBlock>;

// ==[HUMAN APPROVED]== The outgoing presentation role a Definition slot's content is sent as.
// It controls model-request presentation only: it never changes which
// Participant supplies the text or how owner-relative macros expand.
export const promptOutgoingRole = Type.Union([
	Type.Literal("system"),
	Type.Literal("user"),
	Type.Literal("assistant"),
]);
export type PromptOutgoingRole = Static<typeof promptOutgoingRole>;

// ==[HUMAN APPROVED]== The outgoing role each reference assembles with until an author chooses
// otherwise. These are exactly today's assembly roles, so the initial
// Default recipe reproduces the established request and a newly added
// reference starts with the familiar presentation. History is absent: its
// entries carry the roles of their own Messages.
export const defaultOutgoingRoles = {
	"model-system-instruction": "system",
	"human-identity": "user",
	"model-identity": "assistant",
	"model-scenario": "system",
	"model-example-dialogue": "user",
	"model-post-history-instruction": "system",
} as const satisfies Record<ReferencedDefinitionBlock, PromptOutgoingRole>;

export const promptBlockReference = Type.Union([
	...referencedDefinitionBlocks,
	Type.Literal("history"),
]);
export type PromptBlockReference = Static<typeof promptBlockReference>;

// ==[HUMAN APPROVED]== An authored instruction block's reference literal. It is not a Referenced
// Prompt Block: its text is owned by the preset, edited in the block editor,
// and expanded with the Conversation's current Control pair rather than a
// Definition owner.
export const promptInstructionReference = Type.Literal("instruction");
export type PromptInstructionReference = Static<typeof promptInstructionReference>;

// ==[HUMAN APPROVED]== Every stored slot reference a recipe row can carry, for validation and
// reads that must not silently drop a future slot kind.
export const promptPresetBlockReference = Type.Union([
	promptBlockReference,
	promptInstructionReference,
]);
export type PromptPresetBlockReference = Static<typeof promptPresetBlockReference>;

// ==[HUMAN APPROVED]== One ordered recipe slot as the compiler consumes it. Referenced slots
// name Conversation or Participant content and carry only their outgoing
// role; an authored instruction slot carries its own editable name, text,
// and role. Enablement lives on the slot so a disabled slot keeps its place
// in the order instead of disappearing from it. The outgoing role is null
// only for the history slot, whose entries keep the roles of their own
// Messages.
export const promptPresetSlot = Type.Union([
	Type.Object({
		reference: promptBlockReference,
		enabled: Type.Boolean(),
		role: Type.Union([promptOutgoingRole, Type.Null()]),
	}),
	Type.Object({
		reference: promptInstructionReference,
		enabled: Type.Boolean(),
		role: promptOutgoingRole,
		name: Type.String(),
		content: Type.String(),
	}),
]);
export type PromptPresetSlot = Static<typeof promptPresetSlot>;

// ==[HUMAN APPROVED]== A stored slot with its occurrence identity. Deliberate duplicates of the
// same reference are separate occurrences, so every editor operation
// addresses one row by `id` instead of by reference. An instruction
// occurrence carries its authored name and text; referenced occurrences
// never do, because the preset stores references, not rendered content.
export const promptPresetBlockOccurrence = Type.Union([
	Type.Object({
		id: Type.Integer(),
		reference: promptBlockReference,
		enabled: Type.Boolean(),
		role: Type.Union([promptOutgoingRole, Type.Null()]),
	}),
	Type.Object({
		id: Type.Integer(),
		reference: promptInstructionReference,
		enabled: Type.Boolean(),
		role: promptOutgoingRole,
		name: Type.String(),
		content: Type.String(),
	}),
]);
export type PromptPresetBlockOccurrence = Static<typeof promptPresetBlockOccurrence>;

/** A stored Prompt Preset: the ordered recipe Generation assembles through. */
export const promptPresetRecipe = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	slots: Type.Array(promptPresetBlockOccurrence),
});
export type PromptPresetRecipe = Static<typeof promptPresetRecipe>;

// ==[HUMAN APPROVED]== Native interchange deliberately omits stored occurrence ids and the
// Conversation-resolved view. References remain references, while authored
// instruction occurrences carry only their own source text and metadata.
// This is the complete supported native recipe format; it does not archive
// Generation Settings, connection details, Participants, or history.
const nativePromptPresetSlot = Type.Union([
	Type.Object({
		reference: Type.Union([...referencedDefinitionBlocks]),
		enabled: Type.Boolean(),
		role: promptOutgoingRole,
	}),
	Type.Object({
		reference: Type.Literal("history"),
		enabled: Type.Boolean(),
		role: Type.Null(),
	}),
	Type.Object({
		reference: promptInstructionReference,
		enabled: Type.Boolean(),
		role: promptOutgoingRole,
		name: Type.String(),
		content: Type.String(),
	}),
]);

export const nativePromptPreset = Type.Object({
	name: Type.String(),
	slots: Type.Array(nativePromptPresetSlot),
});
export type NativePromptPreset = Static<typeof nativePromptPreset>;

// ==[HUMAN APPROVED]== SillyTavern import is deliberately a review/commit flow. The source is
// kept as opaque JSON at the wire boundary so the server can validate the supported subset
// without pretending that unsupported source settings are native recipe fields.
export const sillyTavernImportRequest = Type.Object({
	source: Type.Unknown(),
	name: Type.Optional(Type.String()),
	orderListId: Type.Optional(Type.String()),
});
export type SillyTavernImportRequest = Static<typeof sillyTavernImportRequest>;

export const sillyTavernImportDiagnostic = Type.Object({
	severity: Type.Union([Type.Literal("warning"), Type.Literal("error")]),
	code: Type.String(),
	message: Type.String(),
	identifier: Type.Optional(Type.String()),
});
export type SillyTavernImportDiagnostic = Static<typeof sillyTavernImportDiagnostic>;

export const sillyTavernOrderChoice = Type.Object({
	id: Type.String(),
	label: Type.String(),
	entryCount: Type.Integer(),
});
export type SillyTavernOrderChoice = Static<typeof sillyTavernOrderChoice>;

export const sillyTavernImportPreview = Type.Object({
	name: Type.String(),
	native: nativePromptPreset,
	diagnostics: Type.Array(sillyTavernImportDiagnostic),
	orderLists: Type.Array(sillyTavernOrderChoice),
	selectedOrderId: Type.Union([Type.String(), Type.Null()]),
	requiresOrderSelection: Type.Boolean(),
});
export type SillyTavernImportPreview = Static<typeof sillyTavernImportPreview>;

// ==[HUMAN APPROVED]== The read-only resolution one Chat sees. A Definition slot carries the
// Participant it reads, that Participant's authored source text, and the
// outgoing role the slot assembles with; the history slot carries the number
// of selected narrative path entries it contributes, because its content is
// Messages rather than authored text. `sourceName` is null when the
// Conversation has no Participant in that Control seat.
export const resolvedPromptPresetSlot = Type.Union([
	Type.Object({
		id: Type.Integer(),
		reference: referencedDefinitionBlock,
		enabled: Type.Boolean(),
		role: promptOutgoingRole,
		sourceName: Type.Union([Type.Null(), Type.String()]),
		content: Type.String(),
	}),
	Type.Object({
		id: Type.Integer(),
		reference: Type.Literal("history"),
		enabled: Type.Boolean(),
		entryCount: Type.Integer(),
	}),
	// ==[HUMAN APPROVED]== The resolved view of an instruction occurrence is the stored authored
	// name and text: unlike a referenced block there is no Conversation-local
	// source, so what the editor shows and what Generation compiles are the
	// same stored text.
	Type.Object({
		id: Type.Integer(),
		reference: promptInstructionReference,
		enabled: Type.Boolean(),
		role: promptOutgoingRole,
		name: Type.String(),
		content: Type.String(),
	}),
]);
export type ResolvedPromptPresetSlot = Static<typeof resolvedPromptPresetSlot>;

export const conversationPromptPreset = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	slots: Type.Array(resolvedPromptPresetSlot),
});
export type ConversationPromptPreset = Static<typeof conversationPromptPreset>;

// ==[HUMAN APPROVED]== The library entry every preset list shows. `conversationCount` is
// the deletion impact presented with every authoritative read, exactly like
// the Character Library's provenance reference count: the confirmation flow
// shows how many Conversations move to Default before any command, while the
// command itself derives the authoritative reassignment at execution time.
export const promptPresetSummary = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	revision: Type.Integer(),
	isDefault: Type.Boolean(),
	conversationCount: Type.Integer(),
});
export type PromptPresetSummary = Static<typeof promptPresetSummary>;

export const sillyTavernImportApplied = Type.Object({
	name: Type.String(),
	native: nativePromptPreset,
	diagnostics: Type.Array(sillyTavernImportDiagnostic),
	orderLists: Type.Array(sillyTavernOrderChoice),
	selectedOrderId: Type.Union([Type.String(), Type.Null()]),
	requiresOrderSelection: Type.Boolean(),
	preset: promptPresetSummary,
});
export type SillyTavernImportApplied = Static<typeof sillyTavernImportApplied>;

export const promptPresetListResponse = Type.Object({
	presets: Type.Array(promptPresetSummary),
});
export type PromptPresetListResponse = Static<typeof promptPresetListResponse>;

// Creation names a blank recipe; the recipe stays empty until the editor
// tickets add block operations.
export const promptPresetCreateCommand = Type.Object({
	type: Type.Literal("create"),
	name: Type.String(),
});

// ==[HUMAN APPROVED]== Every mutation except creation guards the revision the caller saw,
// matching the Character Library convention. Duplicate carries the new
// preset's name so naming stays an explicit library operation.
export const promptPresetRenameCommand = Type.Object({
	type: Type.Literal("rename"),
	presetId: Type.Integer(),
	expectedRevision: Type.Integer(),
	name: Type.String(),
});

export const promptPresetDuplicateCommand = Type.Object({
	type: Type.Literal("duplicate"),
	presetId: Type.Integer(),
	expectedRevision: Type.Integer(),
	name: Type.String(),
});

// ==[HUMAN APPROVED]== Confirmed deletion. The expected revision guards against deleting a
// preset whose affected-Conversation count the caller has not seen; the
// outcome derives the authoritative reassignment at command time.
export const promptPresetDeleteCommand = Type.Object({
	type: Type.Literal("delete"),
	presetId: Type.Integer(),
	expectedRevision: Type.Integer(),
});

export const promptPresetCommandBody = Type.Union([
	promptPresetCreateCommand,
	promptPresetRenameCommand,
	promptPresetDuplicateCommand,
	promptPresetDeleteCommand,
]);
export type PromptPresetCommand = Static<typeof promptPresetCommandBody>;

// ==[HUMAN APPROVED]== Outcome of a confirmed deletion: the reassignment count is derived
// from the selections present at command time, never guessed by the client.
export const promptPresetDeletionResult = Type.Object({
	presetId: Type.Integer(),
	reassignedConversationCount: Type.Integer(),
});
export type PromptPresetDeletionResult = Static<typeof promptPresetDeletionResult>;

// Deletion returns the typed reassignment result instead of a summary; every
// other command returns the authoritative updated preset.
export const promptPresetCommandApplied = Type.Union([
	Type.Object({
		outcome: Type.Literal("applied"),
		preset: promptPresetSummary,
	}),
	Type.Object({
		outcome: Type.Literal("applied"),
		result: promptPresetDeletionResult,
	}),
]);
export type PromptPresetCommandApplied = Static<typeof promptPresetCommandApplied>;

// Stale-revision conflict carrying the authoritative current preset so the
// caller can recover without a follow-up read.
export const promptPresetConflict = Type.Object({
	outcome: Type.Literal("conflict"),
	expectedRevision: Type.Integer(),
	actualRevision: Type.Integer(),
	currentPreset: promptPresetSummary,
});
export type PromptPresetConflict = Static<typeof promptPresetConflict>;

// ==[HUMAN APPROVED]== The command route's typed 409 payload: the recoverable stale
// revision conflict, or the refusal of a Default deletion.
export const promptPresetCommandConflict = Type.Union([
	promptPresetConflict,
	notRemovableOutcome,
]);

// ==[HUMAN APPROVED]== The authoritative recipe operations the popup composes. Each operation
// persists the smallest change it names: adding one reference, moving one
// occurrence, toggling one occurrence, duplicating one occurrence, removing
// one occurrence, or saving one occurrence's outgoing role — never a
// whole-recipe rewrite that could stomp separately saved changes.
export const addPromptPresetBlockBody = Type.Object({ reference: promptBlockReference });
export const movePromptPresetBlockBody = Type.Object({
	toPosition: Type.Integer({ minimum: 1 }),
});
export const setPromptPresetBlockEnabledBody = Type.Object({ enabled: Type.Boolean() });
export const setPromptPresetBlockRoleBody = Type.Object({ role: promptOutgoingRole });

// ==[HUMAN APPROVED]== The one authored-instruction save. Name, text, and outgoing role are a
// single block-level Save boundary: the operation names one occurrence and
// writes only its rows, so a stale draft can never overwrite separately
// saved ordering or toggles.
export const setPromptPresetBlockContentBody = Type.Object({
	name: Type.String(),
	content: Type.String(),
	role: promptOutgoingRole,
});
export type SetPromptPresetBlockContent = Static<typeof setPromptPresetBlockContentBody>;

export const presetIdParams = Type.Object({ presetId: numericWire });
export const blockIdParams = Type.Object({
	presetId: numericWire,
	blockId: numericWire,
});
