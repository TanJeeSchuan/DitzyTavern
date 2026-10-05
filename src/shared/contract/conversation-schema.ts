import { Kind, Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { characterConflict, characterSnapshot } from "./character-library";
import {
	canonicalGenerationSettings,
	effectiveGenerationSettings,
} from "./generation-settings";
import { genericDataNamespacePattern } from "../import-data";
import { portrait } from "./image";
import { promptChannels } from "./prompt-schema";
import {
	invalidOutcome,
	notFoundOutcome,
	notPlayableOutcome,
	notRemovableOutcome,
	conflictReasonOutcome,
} from "./outcomes";
import { numericWire } from "./wire";
import type {
	GenerationJsonObject,
	GenerationJsonValue,
	GenerationProvenance as SharedGenerationProvenance,
	ProvenanceSettingsField,
} from "../generation-provenance";
import { macroVariableWrite } from "./macro-variable-write";
import { loreActivationRecord } from "./lore-activation";
export type { LoreActivationRecord } from "./lore-activation";
import { memoryActivationRecord } from "./memory-recall";
export type { MemoryActivationRecord } from "./memory-recall";

export { effectiveGenerationSettings } from "./generation-settings";

const promptHistoryRole = Type.Union([
	Type.Literal("human"),
	Type.Literal("model"),
	Type.Null(),
]);

// ==[HUMAN APPROVED]== Definition-sourced plan blocks carry the provider-neutral presentation
// role their recipe slot chose; history blocks carry the authorship roles of
// their own Messages. The Model Client owns the translation into provider
// vocabulary. Every Definition-sourced kind has the same fields, so the kind
// is a label union rather than a discriminated set of identical shapes.
const promptDefinitionRole = Type.Union([
	Type.Literal("system"),
	Type.Literal("human"),
	Type.Literal("model"),
]);

const promptDefinitionBlockKind = Type.Union([
	Type.Literal("system-instruction"),
	Type.Literal("identity"),
	Type.Literal("scenario"),
	Type.Literal("example-dialogue"),
	Type.Literal("post-history-instruction"),
	// ==[HUMAN APPROVED]== An authored instruction block's plan entry. Like Definition-sourced
	// blocks it carries its expanded content and the recipe-chosen outgoing
	// role; unlike them its text was authored in the preset, not resolved from
	// a Participant.
	Type.Literal("instruction"),
	Type.Literal("lore"),
	Type.Literal("memory"),
]);

const promptBlock = Type.Union([
	Type.Object({
		kind: promptDefinitionBlockKind,
		role: promptDefinitionRole,
		content: Type.String(),
	}),
	Type.Object({
		kind: Type.Literal("history"),
		speakerName: Type.Union([Type.Null(), Type.String()]),
		content: Type.String(),
		role: promptHistoryRole,
	}),
]);

const generationIntent = Type.Union([
	Type.Object({ type: Type.Literal("sibling") }),
	Type.Object({
		type: Type.Literal("continuation"),
		strategy: Type.Literal("instruction"),
		instruction: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("continuation"),
		strategy: Type.Literal("assistant-prefill"),
		suffix: Type.Union([
			Type.Literal(""),
			Type.Literal(" "),
			Type.Literal("\n"),
			Type.Literal("\n\n"),
		]),
	}),
]);

const promptImage = Type.Object({
	block: Type.Integer(),
	start: Type.Integer(),
	hash: Type.String(),
	name: Type.String(),
	disposition: Type.Union([Type.Literal("send"), Type.Literal("anchor"), Type.Literal("text-only"), Type.Literal("missing")]),
	tokens: Type.Integer(),
});

// The persisted capture is the provider-neutral PromptPlan, kept typed at
// the storage and transport boundary so inspection cannot silently discard
// authorship or continuation intent.
export const promptPlan = Type.Object({
	blocks: Type.Array(promptBlock),
	warnings: Type.Array(Type.Object({
		block: Type.String(),
		macro: Type.String(),
	})),
	images: Type.Array(promptImage),
	intent: Type.Optional(generationIntent),
});

export type PromptPlan = Static<typeof promptPlan>;
export type PromptBlock = PromptPlan["blocks"][number];
export type PromptWarning = PromptPlan["warnings"][number];
export type PromptImage = PromptPlan["images"][number];
export type GenerationIntent = NonNullable<PromptPlan["intent"]>;
export type PromptHistoryRole = Extract<
	PromptBlock,
	{ kind: "history" }
>["role"];

const castParticipant = Type.Object({
	id: Type.Integer(),
	position: Type.Integer(),
	name: Type.String(),
	prompt: promptChannels,
	openings: Type.Array(Type.String()),
	portrait: Type.Optional(portrait),
	sourceCharacterId: Type.Union([Type.Null(), Type.Integer()]),
	sourceCharacterName: Type.Union([Type.Null(), Type.String()]),
	// Derived fields so clients never reproduce Cast rules.
	duplicateLabel: Type.String(),
	removal: Type.Object({
		eligible: Type.Boolean(),
		reason: Type.Union([Type.Literal("control-assigned"), Type.Null()]),
		// Derived removal impact presented by the confirmation flow: the
		// deletion mode names hard delete versus tombstone, and the
		// affected-generation count states how many Messages lose future
		// sibling Variant generation.
		deletionMode: Type.Union([
			Type.Literal("hard-delete"),
			Type.Literal("tombstone"),
			Type.Null(),
		]),
		affectedGenerationCount: Type.Integer(),
	}),
});

const conversationControl = Type.Object({
	humanParticipantId: Type.Union([Type.Null(), Type.Integer()]),
	modelParticipantId: Type.Union([Type.Null(), Type.Integer()]),
});

const conversationControlValidity = Type.Object({
	valid: Type.Boolean(),
	reason: Type.Union([
		Type.Literal("missing-seat"),
		Type.Literal("seats-not-distinct"),
		Type.Literal("seat-not-in-cast"),
		Type.Null(),
	]),
});

const capabilityAvailability = Type.Object({
	available: Type.Boolean(),
	reason: Type.Union([
		Type.Literal("conversation-not-playable"),
		Type.Null(),
	]),
});

const conversationCapabilities = Type.Object({
	compose: capabilityAvailability,
	generate: capabilityAvailability,
	swipe: capabilityAvailability,
});

// Derived capability types share the same canonical declaration with the
// Conversation domain seam (ADR-0032): the domain re-exports these Statics
// instead of restating the shapes, so a new capability or block reason
// cannot drift between transport and domain.
export type CapabilityAvailability = Static<typeof capabilityAvailability>;
export type ConversationCapabilities = Static<typeof conversationCapabilities>;

// Provider request overrides and retained generation details are restricted
// to the shared generation JSON vocabulary. The runtime schema stays open
// like the previous opaque payload boundary, while the Unsafe generic keeps
// Eden's Static type exact and recursive instead of widening these fields to
// `unknown`.
const jsonValue = Type.Unsafe<GenerationJsonValue>({ [Kind]: "Unknown" });

export type GenerationRequestOverrides = GenerationJsonObject;

const activeGenerations = Type.Array(Type.Object({
	generationId: Type.Integer(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	startedAt: Type.String(),
}));

// The conversational transport shape for every response that returns a
// Conversation: the header, the full Cast, Control, and the derived
// playability and capability state. Messages and per-Conversation data are
// deliberately never shipped here: the story reads through the paginated
// history seam, heavy provenance loads only through the Import Details
// operations, and a 92-byte Cast command must not re-serialize the entire
// Chat archive across the wire.
export const conversationSummary = Type.Object({
	id: Type.Integer(),
	name: Type.String(),
	revision: Type.Integer(),
	cast: Type.Array(castParticipant),
	control: conversationControl,
	controlValidity: conversationControlValidity,
	playable: Type.Boolean(),
	capabilities: conversationCapabilities,
	activeGenerations,
});

export type CastParticipant = Static<typeof castParticipant>;
export type ConversationControl = Static<typeof conversationControl>;
export type ConversationControlValidity = Static<typeof conversationControlValidity>;
export type ConversationSummary = Static<typeof conversationSummary>;

// The public Generation Settings payload derives from the canonical
// declaration (ADR-0032): the complete Conversation-owned settings shape
// and its validation semantics. The transport owns a deep clone instead of
// an alias because the HTTP runtime mutates response schemas in place — it
// injects additionalProperties: false when it compiles a response
// validator — and the canonical declaration must stay pristine for the
// adapters that derive from it. The established export name stays for
// every existing consumer.
export const conversationGenerationSettings = Type.Object({
	connectionProfileId: Type.Union([Type.Null(), Type.Integer()]),
	...Value.Clone(canonicalGenerationSettings).properties,
});

export type ConversationGenerationSettings = Static<typeof conversationGenerationSettings>;
export type ContinuationPrefillSuffix = ConversationGenerationSettings["continuationPrefillSuffix"];

export const generationVariant = Type.Object({
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	content: Type.String(),
	timestamp: Type.String(),
	data: Type.Array(Type.Object({
		namespace: Type.String(),
		key: Type.String(),
		value: Type.String(),
	})),
});

export type GenerationVariant = Static<typeof generationVariant>;

// Provenance describes one historical attempt, so every retained settings
// field widens to a nullable wire kind instead of reusing the capture-time
// validation domain: a value a past or future version recorded must still
// display, and a value that did not participate decodes as null rather than
// an accidental zero or empty string. The satisfies lock makes a missing or
// unknown canonical field a compile error, and the focused contract test
// keeps the declared keys aligned with the canonical retained vocabulary.
const provenanceSettingsWireSchemas = {
	temperature: Type.Union([Type.Null(), Type.Number()]),
	topP: Type.Union([Type.Null(), Type.Number()]),
	frequencyPenalty: Type.Union([Type.Null(), Type.Number()]),
	presencePenalty: Type.Union([Type.Null(), Type.Number()]),
	contextLimit: Type.Union([Type.Null(), Type.Integer()]),
	responseBudget: Type.Union([Type.Null(), Type.Integer()]),
	safetyAllowance: Type.Union([Type.Null(), Type.Integer()]),
	siblingGenerationLimit: Type.Union([Type.Null(), Type.Integer()]),
	continuationStrategy: Type.Union([
		Type.Null(),
		Type.Literal("instruction"),
		Type.Literal("assistant-prefill"),
	]),
	continuationInstruction: Type.Union([Type.Null(), Type.String()]),
	continuationPrefillSuffix: Type.Union([
		Type.Null(),
		Type.Literal(""),
		Type.Literal(" "),
		Type.Literal("\n"),
		Type.Literal("\n\n"),
	]),
	repeatedImagePlacement: Type.Union([
		Type.Null(),
		canonicalGenerationSettings.properties.repeatedImagePlacement,
	]),
} as const satisfies { readonly [K in ProvenanceSettingsField]: TSchema };

export const generationProvenanceSettingsWire = Type.Object(provenanceSettingsWireSchemas);

const memorySourceAvailability = Type.Object({
	messageIds: Type.Array(Type.Integer()),
	variantIds: Type.Array(Type.Integer()),
});

const generationProvenance = Type.Union([Type.Null(), Type.Object({
	connectionProfileId: Type.Union([Type.Null(), Type.Integer()]),
	connectionSettingsRevision: Type.Union([Type.Null(), Type.Integer()]),
	modelBackend: Type.Union([Type.Null(), Type.String()]),
	adapter: Type.Union([Type.Null(), Type.String()]),
	modelId: Type.Union([Type.Null(), Type.String()]),
	generationSettings: generationProvenanceSettingsWire,
	usage: Type.Union([Type.Null(), Type.Record(Type.String(), Type.Number())]),
	finishReason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("other"), Type.Null()]),
	status: Type.Union([Type.Literal("complete"), Type.Literal("length-limited"), Type.Literal("interrupted")]),
	interruptionCause: Type.Union([Type.Null(), Type.String()]),
})]);

// Active details are intentionally a separate contract from Conversation
// summaries and ordinary history. Opaque prompt JSON is provider-neutral and
// retained only for the bounded Active Generation/replay lifecycle.
export const activeGenerationDetails = Type.Object({
	conversationId: Type.Integer(),
	generationId: Type.Integer(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	startedAt: Type.String(),
	status: Type.Union([
		Type.Literal("active"),
		Type.Literal("complete"),
		Type.Literal("length-limited"),
		Type.Literal("interrupted"),
	]),
	intent: jsonValue,
	participants: Type.Object({
		human: Type.Object({ id: Type.Integer(), name: Type.String() }),
		model: Type.Object({ id: Type.Integer(), name: Type.String() }),
	}),
	promptPlan,
	promptContext: jsonValue,
	loreActivation: Type.Optional(Type.Union([loreActivationRecord, Type.Null()])),
	memoryActivation: Type.Optional(Type.Union([memoryActivationRecord, Type.Null()])),
	memorySources: memorySourceAvailability,
	generationSettings: jsonValue,
	connection: jsonValue,
	budget: Type.Object({
		tokenEstimate: Type.Union([Type.Null(), Type.Integer()]),
		responseBudget: Type.Union([Type.Null(), Type.Integer()]),
		safetyAllowance: Type.Union([Type.Null(), Type.Integer()]),
		contextLimit: Type.Union([Type.Null(), Type.Integer()]),
		totalRequiredTokens: Type.Union([Type.Null(), Type.Integer()]),
		omittedContext: jsonValue,
	}),
	checkpoint: Type.Object({
		content: Type.String(),
		reasoning: Type.String(),
		latestEventId: Type.Integer(),
		checkpointedAt: Type.Union([Type.Null(), Type.String()]),
	}),
});

export type GenerationInspectionStatus = Static<typeof activeGenerationDetails>["status"];
export type ActiveGenerationDetails = Static<typeof activeGenerationDetails>;

export const variantDetails = Type.Object({
	conversationId: Type.Integer(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	content: Type.String(),
	timestamp: Type.String(),
	author: Type.Union([Type.Null(), Type.Object({
		participantId: Type.Union([Type.Null(), Type.Integer()]),
		capturedName: Type.Union([Type.Null(), Type.String()]),
		inCast: Type.Boolean(),
	})]),
	historicalContext: Type.Union([Type.Null(), Type.Object({
		humanParticipantId: Type.Integer(),
		modelParticipantId: Type.Integer(),
	})]),
	provenance: generationProvenance,
	// Captured activation evidence is independent from compact Generation provenance
	// during the active inspection lifecycle.
	loreActivation: Type.Union([loreActivationRecord, Type.Null()]),
	memoryActivation: Type.Union([memoryActivationRecord, Type.Null()]),
	memorySources: memorySourceAvailability,
});

export type GenerationProvenance = SharedGenerationProvenance;
export type VariantDetails = Static<typeof variantDetails>;

// Lightweight paginated history read contract: stable chronological pages
// of native Messages with the Participant identity and selected Variant
// state needed for rendering. Reasoning Content is included when present;
// unrelated provenance never crosses this contract.
const chatHistoryVariant = Type.Object({
	id: Type.Integer(),
	position: Type.Integer(),
	content: Type.String(),
	reasoning: Type.Optional(Type.String()),
	liveGeneration: Type.Optional(Type.Object({
		generationId: Type.Integer(),
		eventId: Type.Integer(),
		content: Type.String(),
		reasoning: Type.String(),
	})),
	timestamp: Type.String(),
	selected: Type.Boolean(),
});

export type ChatHistoryVariant = Static<typeof chatHistoryVariant>;

// Server-owned targeted Swipe eligibility (ADR-0003, ADR-0031): the
// canonical server rule derives it from playability and the captured
// historical Control pair. Discriminated on `eligible` so a reason can
// never accompany an eligible Message (or vanish from an ineligible one).
const messageSwipeEligibility = Type.Union([
	Type.Object({ eligible: Type.Literal(true), reason: Type.Null() }),
	Type.Object({
		eligible: Type.Literal(false),
		reason: Type.Union([
			Type.Literal("conversation-not-playable"),
			Type.Literal("missing-historical-context"),
			Type.Literal("historical-participant-unavailable"),
		]),
	}),
]);

const chatHistoryMessage = Type.Object({
	id: Type.Integer(),
	position: Type.Integer(),
	timestamp: Type.String(),
	// Historical model Control identity used to decide whether a terminal
	// Message is eligible for Continue after Control changes.
	modelParticipantIdAtCreation: Type.Union([Type.Null(), Type.Integer()]),
	// Server-derived capabilities for the selected Variant and the captured
	// historical Control pair. The server always emits them; a client never
	// reconstructs them from optional hints.
	continuable: Type.Boolean(),
	swipe: messageSwipeEligibility,
	author: Type.Union([Type.Null(), Type.Object({
		participantId: Type.Union([Type.Null(), Type.Integer()]),
		capturedName: Type.Union([Type.Null(), Type.String()]),
		inCast: Type.Boolean(),
	})]),
	variants: Type.Array(chatHistoryVariant),
});

export type ChatHistoryMessage = Static<typeof chatHistoryMessage>;

export const chatHistoryPage = Type.Object({
	conversationId: Type.Integer(),
	name: Type.String(),
	revision: Type.Integer(),
	cast: Type.Array(
		Type.Object({
			id: Type.Integer(),
			position: Type.Integer(),
			name: Type.String(),
		}),
	),
	page: Type.Object({
		index: Type.Integer(),
		pageSize: Type.Integer(),
		totalMessages: Type.Integer(),
		totalPages: Type.Integer(),
		hasOlder: Type.Boolean(),
		hasNewer: Type.Boolean(),
	}),
	messages: Type.Array(chatHistoryMessage),
});

export type ChatHistoryPage = Static<typeof chatHistoryPage>;

// The author stamp is inline in the message schema; derive it so the
// paginated history client can type Participant stamps without a duplicate
// declaration.
export type ChatHistoryAuthorStamp = NonNullable<ChatHistoryMessage["author"]>;

const participantDefinition = Type.Object({
	name: Type.String(),
	prompt: promptChannels,
	openings: Type.Array(Type.String()),
	portrait: Type.Optional(portrait),
});

export type ParticipantDefinition = Static<typeof participantDefinition>;

const dataScope = Type.Union([
	Type.Object({ type: Type.Literal("conversation") }),
	Type.Object({ type: Type.Literal("message"), messageId: Type.Integer() }),
	Type.Object({
		type: Type.Literal("variant"),
		messageId: Type.Integer(),
		variantId: Type.Integer(),
	}),
]);

const createMessageAction = Type.Object({
	type: Type.Literal("create-message"),
	timestamp: Type.String(),
	variantContents: Type.Array(Type.String()),
	selectedVariantIndex: Type.Optional(Type.Integer()),
	authorParticipantId: Type.Integer(),
});

const createVariantAction = Type.Object({
	type: Type.Literal("create-variant"),
	messageId: Type.Integer(),
	content: Type.String(),
});

const selectVariantAction = Type.Object({
	type: Type.Literal("select-variant"),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
});

const editVariantAction = Type.Object({
	type: Type.Literal("edit-variant"),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
	content: Type.String(),
});

const deleteVariantAction = Type.Object({
	type: Type.Literal("delete-variant"),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
});

const deleteMessageAction = Type.Object({
	type: Type.Literal("delete-message"),
	messageId: Type.Integer(),
});

// Generic data commands cannot address namespaces owned by server domains.
const putDataAction = Type.Object({
	type: Type.Literal("put-data"),
	scope: dataScope,
	namespace: Type.String({ pattern: genericDataNamespacePattern }),
	key: Type.String(),
	value: Type.String(),
});

const deleteDataAction = Type.Object({
	type: Type.Literal("delete-data"),
	scope: dataScope,
	namespace: Type.String({ pattern: genericDataNamespacePattern }),
	key: Type.String(),
});

// The settings update command carries the complete canonical declaration:
// the server is authoritative (ADR-0002) and accepts no omitted client
// fields. The Conversation module still fills defaults when it creates
// settings server-side, but an update always states every field, so adding
// a canonical field automatically participates in the update command.
export const generationSettingsUpdate = Value.Clone(canonicalGenerationSettings);

const updateGenerationSettingsAction = Type.Object({
	type: Type.Literal("update-generation-settings"),
	settings: generationSettingsUpdate,
});

// The focused model-selection command: the composer's selector submits only
// the model ID, and the Conversation module merges it into the stored
// Generation Settings inside the command transaction. A model selection
// therefore cannot carry — and cannot restore — any other editor's settings
// fields the way a second full-object writer could.
const setGenerationModelAction = Type.Object({
	type: Type.Literal("set-generation-model"),
	connectionProfileId: Type.Integer(),
	modelId: Type.String({ pattern: "\\S" }),
});

// Cast management command. The raw command appends an ad-hoc or already-
// resolved local Definition only; Character-to-Cast forks flow through the
// explicit workflow route, which checks both revisions and copies the
// authoritative Definition server-side. `sourceCharacterId` is deliberately
// absent here so a client can never forge or bypass provenance/revision
// rules at the transport boundary.
const addParticipantAction = Type.Object({
	type: Type.Literal("add-participant"),
	definition: participantDefinition,
});

const renameParticipantAction = Type.Object({
	type: Type.Literal("rename-participant"),
	participantId: Type.Integer(),
	name: Type.String(),
});

const updateParticipantDefinitionAction = Type.Object({
	type: Type.Literal("update-participant-definition"),
	participantId: Type.Integer(),
	definition: participantDefinition,
});

const replaceParticipantPromptAction = Type.Object({
	type: Type.Literal("replace-participant-prompt"),
	participantId: Type.Integer(),
	prompt: promptChannels,
});

const replaceParticipantOpeningsAction = Type.Object({
	type: Type.Literal("replace-participant-openings"),
	participantId: Type.Integer(),
	openings: Type.Array(Type.String()),
});

const renameConversationAction = Type.Object({
	type: Type.Literal("rename-conversation"),
	name: Type.String(),
});

const assignControlAction = Type.Object({
	type: Type.Literal("assign-control"),
	seat: Type.Union([Type.Literal("human"), Type.Literal("model")]),
	participantId: Type.Integer(),
});

// Removes an unseated Participant after confirmation. Seated Participants
// are protected with the typed not-removable outcome; the derived
// deletion-mode and affected-generation count come from the snapshot, never
// reconstructed by the client.
const removeParticipantAction = Type.Object({
	type: Type.Literal("remove-participant"),
	participantId: Type.Integer(),
});

// ==[HUMAN APPROVED]== Selects one shared Prompt Preset for this Conversation. Selection is
// a reference to the library entry, never a copy, and it deliberately stays
// available while an Active Generation exists: the running attempt keeps the
// Prompt Plan it captured, and later attempts use the new selection.
const selectPromptPresetAction = Type.Object({
	type: Type.Literal("select-prompt-preset"),
	promptPresetId: Type.Integer(),
});

const conversationCommandAction = Type.Union([
	createMessageAction,
	createVariantAction,
	selectVariantAction,
	editVariantAction,
	deleteVariantAction,
	deleteMessageAction,
	putDataAction,
	deleteDataAction,
	updateGenerationSettingsAction,
	setGenerationModelAction,
	addParticipantAction,
	renameParticipantAction,
	updateParticipantDefinitionAction,
	replaceParticipantPromptAction,
	replaceParticipantOpeningsAction,
	assignControlAction,
	removeParticipantAction,
	selectPromptPresetAction,
	renameConversationAction,
]);

export type ConversationAction = Static<typeof conversationCommandAction>;

// The revision is part of the Conversation command; the conversation id
// lives in the route path.
export const conversationCommandBody = Type.Object({
	expectedRevision: Type.Integer(),
	action: conversationCommandAction,
});

export const generationFormattingContext = Type.Object({
	// ==[HUMAN APPROVED]== Formatting context belongs to the initiating client, not persisted
	// Conversation settings. It is shared by preview and all three Generation
	// start bodies so the route cannot rename or omit one side.
	timeZone: Type.Optional(Type.String()),
	locale: Type.Optional(Type.String()),
});

export type GenerationFormattingContext = Static<typeof generationFormattingContext>;

const inspectedPlanFields = {
	previewId: Type.Optional(Type.String()),
	promptPlan: Type.Optional(promptPlan),

	...generationFormattingContext.properties,
};

// Send carries the client draft and the Conversation revision it was based
// on. Generation acceptance is deliberately a complete typed operation: an
// omitted revision or draft must never fall through to an older request shape.
export const generationBody = Type.Object({
	expectedRevision: Type.Integer(),
	content: Type.String(),
	// A preview token carries the server-captured macro clock, random draws,
	// and pending writes. The optional plan is the user's direct edit of that
	// capture; it is never treated as provider JSON.
	...inspectedPlanFields,
});

// ==[HUMAN APPROVED]== Continue carries only the Conversation revision. The server derives the
// selected terminal Message and current Control pair from its snapshot.
export const continuationBody = Type.Object({
	expectedRevision: Type.Integer(),
	...inspectedPlanFields,
});

export type ConversationCommandBody = Static<typeof conversationCommandBody>;
export type GenerationBody = Static<typeof generationBody>;
export type ContinuationBody = Static<typeof continuationBody>;

export const siblingGenerationBody = Type.Object({
	...inspectedPlanFields,
});

const generationPreviewKind = Type.Union([
	Type.Literal("send"),
	Type.Literal("continuation"),
	Type.Literal("sibling"),
]);

export const generationPreviewBody = Type.Union([
	Type.Object({
		kind: Type.Literal("send"),
		content: Type.String(),

		...generationFormattingContext.properties,
	}),
	Type.Object({
		kind: Type.Literal("continuation"),
		...generationFormattingContext.properties,
	}),
	Type.Object({
		kind: Type.Literal("sibling"),
		messageId: Type.Integer(),
		...generationFormattingContext.properties,
	}),
]);

const generationPreviewBudget = Type.Object({
	tokenEstimate: Type.Integer(),
	responseBudget: Type.Integer(),
	safetyAllowance: Type.Integer(),
	contextLimit: Type.Integer(),
	totalRequiredTokens: Type.Integer(),
	budgetFits: Type.Boolean(),
});

export const generationPreview = Type.Object({
	outcome: Type.Literal("available"),
	previewId: Type.String(),
	conversationId: Type.Integer(),
	kind: generationPreviewKind,
	promptPlan,
	participants: Type.Object({
		human: Type.Union([Type.Null(), Type.Object({ id: Type.Integer(), name: Type.String() })]),
		model: Type.Union([Type.Null(), Type.Object({ id: Type.Integer(), name: Type.String() })]),
	}),
	effectiveSettings: effectiveGenerationSettings,
	pendingWrites: Type.Array(macroVariableWrite),
	loreActivation: Type.Optional(Type.Union([loreActivationRecord, Type.Null()])),
	memoryActivation: Type.Optional(Type.Union([memoryActivationRecord, Type.Null()])),
	memorySources: memorySourceAvailability,
	budget: generationPreviewBudget,
});

export type SiblingGenerationBody = Static<typeof siblingGenerationBody>;
export type GenerationPreviewBody = Static<typeof generationPreviewBody>;
export type GenerationPreview = Static<typeof generationPreview>;

export const conversationConflict = Type.Object({
	outcome: Type.Literal("conflict"),
	expectedRevision: Type.Integer(),
	actualRevision: Type.Integer(),
	currentConversation: conversationSummary,
});

export const generationAccepted = Type.Object({
	outcome: Type.Literal("accepted"),
	generationId: Type.Integer(),
	conversationId: Type.Integer(),
	messageId: Type.Integer(),
	variantId: Type.Integer(),
});

export const generationStartResponse = Type.Union([
	generationAccepted,
	notFoundOutcome,
	conflictReasonOutcome,
	notPlayableOutcome,
	invalidOutcome,
]);

export type GenerationAccepted = Static<typeof generationAccepted>;
export type GenerationStartResponse = Static<typeof generationStartResponse>;

export const generationStopped = Type.Object({
	outcome: Type.Literal("stopped"),
	generationId: Type.Integer(),
	conversation: conversationSummary,
});

export const generationsStopped = Type.Object({
	outcome: Type.Literal("stopped"),
	generationIds: Type.Array(Type.Integer()),
	conversation: conversationSummary,
});

export type GenerationStopped = Static<typeof generationStopped>;
export type GenerationsStopped = Static<typeof generationsStopped>;

// Route boundary schemas referenced by the Conversation adapter: path and
// query params arrive as wire strings, and the response maps reuse these
// named contracts instead of re-declaring shapes at the boundary.

export const conversationIdParams = Type.Object({ id: numericWire });

export const conversationDeleted = Type.Object({ outcome: Type.Literal("deleted") });

export const generationIdParams = Type.Object({
	id: numericWire,
	generationId: numericWire,
});

export const messageIdParams = Type.Object({
	id: numericWire,
	messageId: numericWire,
});

export const variantIdParams = Type.Object({
	id: numericWire,
	messageId: numericWire,
	variantId: numericWire,
});

export const participantIdParams = Type.Object({
	id: numericWire,
	participantId: numericWire,
});

export const historyPageQuery = Type.Object({
	page: Type.Optional(numericWire),
	pageSize: Type.Optional(numericWire),
});

export const generationEventsQuery = Type.Object({
	after: Type.Optional(numericWire),
});

export const conversationAppliedResponse = Type.Object({
	outcome: Type.Literal("applied"),
	conversation: conversationSummary,
});

export const characterAppliedResponse = Type.Object({
	outcome: Type.Literal("applied"),
	character: characterSnapshot,
});

export const generationConflictResponse = Type.Union([
	conflictReasonOutcome,
	notPlayableOutcome,
]);

export const conversationCommandConflict = Type.Union([
	conversationConflict,
	notPlayableOutcome,
	notRemovableOutcome,
]);

export const castCharacterConflict = Type.Union([
	characterConflict,
	conversationConflict,
]);

export const addCharacterToCastBody = Type.Object({
	expectedConversationRevision: Type.Integer(),
	characterId: Type.Integer(),
	expectedCharacterRevision: Type.Integer(),
});

export const saveParticipantAsCharacterBody = Type.Object({
	expectedConversationRevision: Type.Integer(),
});
