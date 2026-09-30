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
const referencedDefinitionBlockKinds = [
	Type.Literal("model-system-instruction"),
	Type.Literal("human-identity"),
	Type.Literal("model-identity"),
	Type.Literal("model-scenario"),
	Type.Literal("model-example-dialogue"),
	Type.Literal("model-post-history-instruction"),
] as const;

export const referencedDefinitionBlock = Type.Union([...referencedDefinitionBlockKinds]);
export type ReferencedDefinitionBlock = Static<typeof referencedDefinitionBlock>;

export const promptLoreReference = Type.Literal("lore");
export type PromptLoreReference = Static<typeof promptLoreReference>;
export const promptMemoryReference = Type.Literal("memory");
export type PromptMemoryReference = Static<typeof promptMemoryReference>;

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
	lore: "system",
	memory: "system",
} as const satisfies Record<ReferencedDefinitionBlock | PromptLoreReference | PromptMemoryReference, PromptOutgoingRole>;

export const promptBlockReference = Type.Union([
	...referencedDefinitionBlockKinds,
	Type.Literal("history"),
	promptLoreReference,
	promptMemoryReference,
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

// ==[HUMAN APPROVED]== One ordered recipe slot as the compiler consumes it. A referenced
// Definition slot carries its required outgoing role; history carries no
// slot-owned role because its entries keep the roles of their own Messages;
// and an authored instruction carries its editable name, text, and role.
// Enablement lives on the slot so a disabled slot keeps its place in the
// order instead of disappearing from it.
export const promptPresetSlot = Type.Union([
	Type.Object({
		reference: referencedDefinitionBlock,
		enabled: Type.Boolean(),
		role: promptOutgoingRole,
	}),
	Type.Object({
		reference: Type.Union([promptLoreReference, promptMemoryReference]),
		enabled: Type.Boolean(),
		role: promptOutgoingRole,
	}),
	Type.Object({
		reference: Type.Literal("history"),
		enabled: Type.Boolean(),
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

export const hasEnabledMemorySlot = (slots: readonly Pick<PromptPresetSlot, "reference" | "enabled">[]): boolean =>
	slots.some((slot) => slot.reference === "memory" && slot.enabled);
export const hasEnabledLoreSlot = (slots: readonly Pick<PromptPresetSlot, "reference" | "enabled">[]): boolean =>
	slots.some((slot) => slot.reference === "lore" && slot.enabled);

// ==[HUMAN APPROVED]== A stored occurrence derives from the canonical slot and adds only local
// database identity. Deliberate duplicates are separate occurrences, so
// editor operations address one row by `id` instead of by reference.
export const promptPresetBlockOccurrence = Type.Intersect([
	Type.Object({ id: Type.Integer() }),
	promptPresetSlot,
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
// Conversation-resolved view by reusing the canonical slot contract. References
// remain references, while authored instruction occurrences carry only their
// own source text and metadata. This is the complete supported native recipe
// format; it does not archive Generation Settings, connection details,
// Participants, or history.
export const nativePromptPreset = Type.Object({
	name: Type.String(),
	slots: Type.Array(promptPresetSlot),
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
	Type.Object({ id: Type.Integer(), reference: promptLoreReference, enabled: Type.Boolean(), role: promptOutgoingRole }),
	Type.Object({ id: Type.Integer(), reference: promptMemoryReference, enabled: Type.Boolean(), role: promptOutgoingRole }),
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

// ==[HUMAN APPROVED]== Rename, duplicate and delete each carry the expected revision the caller
// saw; creation carries none because it addresses no existing preset. Duplicate
// carries the new preset's name so naming stays an explicit library operation.
// Block patches are occurrence-addressed and travel the recipe route, so every
// command here is revision-guarded.
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

// ==[HUMAN APPROVED]== Confirmed deletion. The expected revision guards the library metadata
// and the confirmed affected-Conversation count guards the deletion impact:
// both must match the authoritative values the author confirmed. The outcome
// derives the reassignment from the selections present at command time.
export const promptPresetDeleteCommand = Type.Object({
	type: Type.Literal("delete"),
	presetId: Type.Integer(),
	expectedRevision: Type.Integer(),
	expectedConversationCount: Type.Integer(),
});

// ==[HUMAN APPROVED]== One occurrence-addressed patch saves block fields and enablement
// without rewriting ordering or another occurrence.
export const promptPresetBlockPatch = Type.Union([
	Type.Object({
		occurrenceId: Type.Integer(),
		type: Type.Literal("role"),
		role: promptOutgoingRole,
		enabled: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		occurrenceId: Type.Integer(),
		type: Type.Literal("content"),
		name: Type.String(),
		content: Type.String(),
		role: promptOutgoingRole,
		enabled: Type.Optional(Type.Boolean()),
	}),
	Type.Object({
		occurrenceId: Type.Integer(),
		type: Type.Literal("enabled"),
		enabled: Type.Boolean(),
	}),
]);
export type PromptPresetBlockPatch = Static<typeof promptPresetBlockPatch>;

// ==[HUMAN APPROVED]== The footer and save-on-leave submit the dirty set atomically.
export const promptPresetBlockPatchesBody = Type.Object({
	patches: Type.Array(promptPresetBlockPatch),
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

// ==[HUMAN APPROVED]== The applied-command wire union states its variant: a summary for every
// metadata command, or the deletion's derived reassignment. Deletion returns
// the typed result instead of a summary because the preset no longer exists.
// Block operations respond through the recipe route with a minimal applied acknowledgment; the
// client reloads the resolved recipe through the Conversation read seam.
export const promptPresetCommandApplied = Type.Union([
	Type.Object({
		outcome: Type.Literal("applied"),
		preset: promptPresetSummary,
	}),
	Type.Object({
		outcome: Type.Literal("deleted"),
		result: promptPresetDeletionResult,
	}),
]);
export type PromptPresetCommandApplied = Static<typeof promptPresetCommandApplied>;

export const promptPresetRecipeApplied = Type.Object({
	outcome: Type.Literal("applied"),
});
export type PromptPresetRecipeApplied = Static<typeof promptPresetRecipeApplied>;

// ==[HUMAN APPROVED]== The two recoverable command conflicts share one 409 envelope: the
// preset's library metadata revision is stale, or the deletion impact the
// author confirmed no longer matches. Both carry the authoritative current
// preset so the caller can recover without a follow-up read.
const promptPresetStaleRevisionConflict = Type.Object({
	outcome: Type.Literal("conflict"),
	reason: Type.Literal("stale-revision"),
	expectedRevision: Type.Integer(),
	actualRevision: Type.Integer(),
	currentPreset: promptPresetSummary,
});
const promptPresetDeletionImpactConflict = Type.Object({
	outcome: Type.Literal("conflict"),
	reason: Type.Literal("deletion-impact"),
	currentPreset: promptPresetSummary,
});
const promptPresetConflict = Type.Union([
	promptPresetStaleRevisionConflict,
	promptPresetDeletionImpactConflict,
]);
export type PromptPresetConflict = Static<typeof promptPresetConflict>;

// ==[HUMAN APPROVED]== The command route's typed 409 payload: a recoverable command conflict,
// or the refusal of a Default deletion.
export const promptPresetCommandConflict = Type.Union([
	promptPresetConflict,
	notRemovableOutcome,
]);

// ==[HUMAN APPROVED]== The authoritative recipe operations the popup composes. Each operation
// persists the smallest change it names: adding one reference, moving one
// occurrence, toggling one occurrence, duplicating one occurrence, or removing
// one occurrence. The Prompt Preset editor sends toggles and authored fields through
// the patch batch; the single-toggle route also serves Lorebooks.
export const addPromptPresetBlockBody = Type.Object({ reference: promptBlockReference });
export const movePromptPresetBlockBody = Type.Object({
	toPosition: Type.Integer({ minimum: 1 }),
});
export const setPromptPresetBlockEnabledBody = Type.Object({ enabled: Type.Boolean() });

export const presetIdParams = Type.Object({ presetId: numericWire });
export const blockIdParams = Type.Object({
	presetId: numericWire,
	blockId: numericWire,
});
