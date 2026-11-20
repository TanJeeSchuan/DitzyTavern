import { defineRule } from "@oxlint/plugins";
import { lexicalTypeParameterNames } from "../../anti-slop/shared/lexical-type-parameters.ts";
import { moduleExportName } from "../imports.ts";
import { repositoryPath } from "../path.ts";

const existingRenames = new Map<string, readonly string[]>([
	// PortraitImage is the public Box SDK type name.
	["src/box-sdk/client.ts", [
		"Portrait as PortraitImage",
	]],
	// The Memory client API names its settings payload for its consumers.
	["src/boxes/memory/client-api.ts", [
		"MemorySettings = MemorySettingsPayload",
	]],
	// Memory views use the existing claim type name.
	["src/boxes/memory/client-view.ts", [
		"MemoryClaim = MemoryCandidateJudgment",
	]],
	// The timeline already names its record values locally.
	["src/client/box-windows/PassageTimeline.tsx", [
		"RecordValue = BoxRecord",
	]],
	// Connection Settings UI callers use the client transport facade.
	["src/client/connection-settings.ts", [
		"ConnectionHeaderOperation = ConnectionHeaderOperationPayload",
		"ConnectionProfileDraft = ConnectionProfileDraftPayload",
		"ConnectionProfile = ConnectionProfilePayload",
		"ConnectionSettings = ConnectionSettingsPayload",
		"ConnectionPreset = ConnectionPresetPayload",
		"TestConnectionDraftInput = ConnectionTestDraftPayload",
		"ConnectionSettingsCommand = ConnectionSettingsCommandPayload",
	]],
	// SSE consumers already use the client stream vocabulary.
	["src/client/conversation-stream.ts", [
		"GenerationStreamDelta = GenerationEvent",
		"GenerationStreamState = GenerationStatePayload",
	]],
	// Lorebook views and tests consume the client library facade.
	["src/client/lorebook-library.ts", [
		"LorebookValue as Lorebook",
		"LoreMatchTest = LoreMatchTestResponse",
	]],
	// Settings UI callers use the existing client type name.
	["src/client/semantic-trigger-settings.ts", [
		"SemanticTriggerSettings = SemanticTriggerSettingsPayload",
	]],
	// Artifact inspection uses these local names for the import contracts.
	["src/server/artifact/types.ts", [
		"ArtifactUnavailableReason = ImportCleanupReason",
		"ArtifactInspection = ImportDetailsArtifact",
	]],
	// Connection Settings consumers import domain names from the server facade.
	["src/server/connection-settings/types.ts", [
		"ConnectionHeaderOperation = ConnectionHeaderOperationPayload",
		"ConnectionProfileDraft = ConnectionProfileDraftPayload",
		"ConnectionProfile = ConnectionProfilePayload",
		"ConnectionSettingsSnapshot = ConnectionSettingsPayload",
		"ConnectionPreset = ConnectionPresetPayload",
	]],
	// Conversation exposes its types through the existing public facade.
	["src/server/conversation/types.ts", [
		"ConversationJsonValue = GenerationJsonValue",
		"ConversationGenerationSettings = SharedConversationGenerationSettings",
		"GenerationJsonObject as GenerationRequestOverrides",
		"ConversationGenerationSettingsInput = CanonicalGenerationSettings",
		"ParticipantDefinition = SharedParticipantDefinition",
		"CastParticipantSnapshot = SharedCastParticipant",
		"ConversationControlSnapshot = SharedConversationControl",
		"ConversationControlValidity = SharedConversationControlValidity",
		"CapabilityAvailability = SharedCapabilityAvailability",
		"ConversationCapabilities = SharedConversationCapabilities",
		"MessageSwipeEligibility = SharedMessageSwipeEligibility",
		"AuthorStampSnapshot = SharedChatHistoryAuthorStamp",
		"HistoricalControlSnapshot = SharedHistoricalControlSnapshot",
		"ConversationSummary = SharedConversationSummary",
		"ChatHistoryVariant = SharedChatHistoryVariant",
		"VariantText = SharedVariantText",
		"ChatHistoryMessage = SharedChatHistoryMessage",
		"ChatHistoryPage = SharedChatHistoryPage",
		"ConversationDataScope = SharedConversationDataScope",
		"ActiveGenerationDetails = SharedActiveGenerationDetails",
		"VariantDetails = SharedVariantDetails",
	]],
	// The seed and its teardown share the seed-specific fixture name.
	["src/server/database/seed.ts", [
		"AdHocPersona = ParticipantDefinition",
	]],
	// Model Client consumers use these names for shared Generation events.
	["src/server/model-client/types.ts", [
		"ModelClientEvent = GenerationEvent",
		"ModelClientUsage = GenerationUsage",
		"ModelClientFailureKind = GenerationFailureKind",
	]],
	// Staged-import callers use these local names for their wire contracts.
	["src/server/sillytavern/staged/types.ts", [
		"ChatImportReceipt = ChatImportReceiptContract",
		"ChatImportGroup = ChatImportGroupContract",
		"ChatImportPreview = ChatImportPreviewContract",
		"ChatImportResolvedParticipantPlan = ChatImportResolvedParticipant",
		"ChatImportCommitInput = ChatImportCommitBody",
	]],
	// Generation Settings callers name the overrides shape explicitly.
	["src/shared/contract/conversation-schema.ts", [
		"GenerationRequestOverrides = GenerationJsonObject",
	]],
]);

export const noTypeAliasRenameRule = defineRule({
	meta: {
		type: "problem",
		messages: {
			typeRename: "Use the original type name instead of a rename-only type alias.",
			exportRename: "Export this binding under its original name.",
		},
	},
	create(context) {
		const exceptions = existingRenames.get(repositoryPath(context.filename));
		return {
			TSTypeAliasDeclaration(node) {
				const target = node.typeAnnotation;
				if (target.type !== "TSTypeReference" || target.typeName.type !== "Identifier" || target.typeArguments != null) return;
				const targetName = target.typeName.name;
				if (lexicalTypeParameterNames(node, context.sourceCode.visitorKeys).has(targetName) ||
					exceptions?.includes(`${node.id.name} = ${targetName}`)) return;
				context.report({ node, messageId: "typeRename" });
			},
			ExportSpecifier(node) {
				const local = moduleExportName(node.local);
				const exported = moduleExportName(node.exported);
				if (local === exported || exceptions?.includes(`${local} as ${exported}`)) return;
				context.report({ node, messageId: "exportRename" });
			},
		};
	},
});
