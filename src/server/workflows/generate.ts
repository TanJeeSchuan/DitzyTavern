// Current Generate workflow.
//
// Composes the deep Conversation seam and the pure Prompt Compiler in one
// deterministic flow: read one authoritative snapshot, compile the
// provider-neutral Prompt Plan from the two controlled Participants and
// selected history, hand the plan to the injected model transport, and
// finally commit the transport's reply as a new Message authored by the
// Participant that occupied model Control when generation started. Everything
// the Message needs to be understood later — the immutable Author Stamp and
// the human/model historical pair — is captured at generation start, so
// concurrent renames or Definition edits never rewrite an in-flight
// generation and affect only later ones.
//
// The transport is injected as a seam: this module stays independent of any
// concrete provider, streaming protocol, or credentials.

import type { Database } from "bun:sqlite";
import {
	createConversationModule,
	ConversationNotPlayableError,
	ConversationNotFoundError,
	deriveMessageSwipeEligibility,
	InvalidConversationCommandError,
	SiblingVariantUnavailableError,
	type ConversationSnapshot,
	type ConversationDataEntry,
} from "../conversation";
import {
	compilePrompt,
	type PromptHistoryEntry,
	type PromptPlan,
} from "../prompt-compiler";
import type { CastParticipantSnapshot } from "../conversation/types";
import {
	collectModelClientContent,
	type ModelClientConnectionSnapshot,
	type ModelClientGenerationSettings,
	type ModelClient,
} from "../model-client";
import {
	createConnectionSettingsModule,
	type ConnectionSettingsModuleOptions,
} from "../connection-settings";
import type { ConversationGenerationSettings } from "../conversation";

export interface ParticipantPreview {
	id: number;
	name: string;
}

// Read-only prompt inspection result. `playable: false` means the
// Conversation cannot currently generate because the two distinct Control
// seats are not both occupied; the plan is then null.
export interface GenerationPromptInspection {
	conversationId: number;
	playable: boolean;
	humanParticipant: ParticipantPreview | null;
	modelParticipant: ParticipantPreview | null;
	plan: PromptPlan | null;
}

export interface GenerateReplyInput {
	conversationId: number;
	// The provider-neutral Model Client receives the compiled Prompt Plan and
	// returns normalized asynchronous events. The workflow never calls a
	// provider or interprets a provider request shape directly.
	modelClient: ModelClient;
	// HTTP adapters provide the same start-time capture used to construct the
	// client. Direct workflow callers may omit it; the workflow resolves the
	// current safe Profile identity itself, preserving the original fake-client
	// seam used by domain tests.
	connection?: ModelClientConnectionSnapshot | null;
	connectionSettings?: ConnectionSettingsModuleOptions;
	// Optional explicit write time; defaults to the current wall clock.
	timestamp?: string | undefined;
}

interface GenerationDerivation {
	plan: PromptPlan;
	humanParticipant: ParticipantPreview;
	modelParticipant: ParticipantPreview;
}

// Selected-history entries for prompt compilation, derived from each
// Message's selected Variant and its immutable Author Stamp name.
// `endExclusiveIndex` limits the entries to Messages strictly preceding a
// targeted sibling Variant; omitted, the entire ordered snapshot counts, as
// a current Generate at the tail uses.
const selectedHistoryFrom = (
	snapshot: ConversationSnapshot,
	endExclusiveIndex?: number,
): readonly PromptHistoryEntry[] =>
	snapshot.messages.slice(0, endExclusiveIndex).flatMap((message) => {
		const selected = message.variants.find((variant) => variant.selected);
		if (selected === undefined) return [];
		return [
			{
				speakerName: message.author?.capturedName ?? null,
				content: selected.content,
			},
		];
	});

const deriveGeneration = (
	snapshot: ConversationSnapshot,
): GenerationDerivation | null => {
	const human = snapshot.cast.find(
		(participant) => participant.id === snapshot.control.humanParticipantId,
	);
	const model = snapshot.cast.find(
		(participant) => participant.id === snapshot.control.modelParticipantId,
	);
	if (human === undefined || model === undefined || human.id === model.id) {
		return null;
	}

	const plan = compilePrompt({
		human: toCompilerDefinition(human),
		model: toCompilerDefinition(model),
		history: selectedHistoryFrom(snapshot),
	});

	return {
		plan,
		humanParticipant: { id: human.id, name: human.name },
		modelParticipant: { id: model.id, name: model.name },
	};
};

const toCompilerDefinition = (participant: CastParticipantSnapshot) => ({
	name: participant.name,
	prompt: {
		systemInstruction: participant.prompt.systemInstruction,
		identity: participant.prompt.identity,
		scenario: participant.prompt.scenario,
		exampleDialogue: participant.prompt.exampleDialogue,
		postHistoryInstruction: participant.prompt.postHistoryInstruction,
	},
});

function captureGenerationSettings(
	database: Database,
	conversationId: number,
	connection: ModelClientConnectionSnapshot | null | undefined,
	connectionSettingsOptions: ConnectionSettingsModuleOptions | undefined,
): GenerationCapture {
	const conversation = createConversationModule(database);
	const settings = conversation.getGenerationSettings(conversationId);
	if (settings === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	const capturedConnection = connection === undefined
		? resolveConnectionSnapshot(database, connectionSettingsOptions)
		: connection;
	const provenance = {
		namespace: "generation",
		key: "provenance",
		value: JSON.stringify({
			connectionProfileId: capturedConnection?.profileId ?? null,
			connectionSettingsRevision: capturedConnection?.settingsRevision ?? null,
			modelBackend: capturedConnection?.backend ?? null,
			adapter: capturedConnection?.adapter ?? null,
			modelId: settings.modelId,
			generationSettings: {
				temperature: settings.temperature,
				topP: settings.topP,
				frequencyPenalty: settings.frequencyPenalty,
				presencePenalty: settings.presencePenalty,
				contextLimit: settings.contextLimit,
				responseBudget: settings.responseBudget,
				requestOverrides: settings.requestOverrides,
			},
		}),
	} satisfies ConversationDataEntry;
	return { settings, connection: capturedConnection, provenance };
}

function resolveConnectionSnapshot(
	database: Database,
	options: ConnectionSettingsModuleOptions | undefined,
): ModelClientConnectionSnapshot | null {
	const settings = createConnectionSettingsModule(database, options).get();
	if (settings.activeProfileId === null) return null;
	const profile = settings.profiles.find(
		(entry) => entry.id === settings.activeProfileId,
	);
	if (profile === undefined) return null;
	return {
		profileId: profile.id,
		settingsRevision: settings.revision,
		backend: "ai-sdk",
		adapter: profile.adapter,
	};
}

const toModelClientGenerationSettings = (
	settings: ConversationGenerationSettings,
): ModelClientGenerationSettings => ({
	temperature: settings.temperature,
	topP: settings.topP,
	frequencyPenalty: settings.frequencyPenalty,
	presencePenalty: settings.presencePenalty,
	contextLimit: settings.contextLimit,
	responseBudget: settings.responseBudget,
	requestOverrides: settings.requestOverrides,
});

// Compiles the Prompt Plan the server would send for a current Generate
// without contacting any transport. Exposes the agreed participant context
// (the Control pair and their plan) using provider-neutral vocabulary only.
export function inspectGenerationPrompt(
	database: Database,
	conversationId: number,
): GenerationPromptInspection {
	const snapshot = createConversationModule(database).getSnapshot(conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}

	const derivation = deriveGeneration(snapshot);
	if (derivation === null) {
		return {
			conversationId,
			playable: false,
			humanParticipant: null,
			modelParticipant: null,
			plan: null,
		};
	}

	return {
		conversationId,
		playable: true,
		humanParticipant: derivation.humanParticipant,
		modelParticipant: derivation.modelParticipant,
		plan: derivation.plan,
	};
}

export async function generateReply(
	database: Database,
	input: GenerateReplyInput,
): Promise<ConversationSnapshot> {
	const conversation = createConversationModule(database);

	// Generation-start capture: one authoritative snapshot derives the plan,
	// the Author Stamp, and the historical Control pair.
	const snapshot = conversation.getSnapshot(input.conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(input.conversationId);
	}
	const derivation = deriveGeneration(snapshot);
	if (derivation === null) {
		// Typed domain result before the transport is ever contacted.
		throw new ConversationNotPlayableError(input.conversationId);
	}
	const { plan, humanParticipant, modelParticipant } = derivation;
	const capture = captureGenerationSettings(
		database,
		input.conversationId,
		input.connection,
		input.connectionSettings,
	);

	const content = await collectModelClientContent(input.modelClient, {
		promptPlan: plan,
		modelId: capture.settings.modelId,
		generationSettings: toModelClientGenerationSettings(capture.settings),
		connection: capture.connection,
	});

	// Commit with the generation-start captures even if the Conversation
	// moved on while the transport was working.
	return conversation.commitGeneration({
		conversationId: input.conversationId,
		timestamp: input.timestamp ?? new Date().toISOString(),
		content,
		authorParticipantId: modelParticipant.id,
		capturedAuthorName: modelParticipant.name,
		humanParticipantId: humanParticipant.id,
		modelParticipantId: modelParticipant.id,
		provenance: capture.provenance,
	});
}

export interface GenerateSiblingVariantInput {
	conversationId: number;
	// The target Message whose captured historical Control pair governs this
	// sibling generation. Current Control is deliberately ignored: Swiping an
	// older Message reproduces the participants who were playing when it was
	// generated, and never reassigns the seats.
	messageId: number;
	// The provider-neutral Model Client receives the compiled Prompt Plan and
	// returns normalized asynchronous events for the sibling Variant.
	modelClient: ModelClient;
	connection?: ModelClientConnectionSnapshot | null;
	connectionSettings?: ConnectionSettingsModuleOptions;
	// Optional explicit write time; defaults to the current wall clock.
	timestamp?: string | undefined;
}

const deriveSiblingDerivation = (
	snapshot: ConversationSnapshot,
	messageId: number,
) => {
	const targetIndex = snapshot.messages.findIndex(
		(message) => message.id === messageId,
	);
	const target = targetIndex === -1 ? undefined : snapshot.messages[targetIndex];
	if (target === undefined) {
		throw new InvalidConversationCommandError(
			`Message ${messageId} does not belong to Conversation ${snapshot.id}.`,
		);
	}

	// Same derived rule as the snapshot exposes: playable Conversation,
	// captured historical pair, and both historical Participants still in
	// the Cast with usable Definitions.
	const eligibility = deriveMessageSwipeEligibility(
		snapshot.playable,
		target.historicalContext,
		snapshot.cast.map((participant) => participant.id),
	);
	if (!eligibility.eligible) {
		if (eligibility.reason === "conversation-not-playable") {
			throw new ConversationNotPlayableError(snapshot.id);
		}
		// The discriminated eligibility narrows the remaining reasons to the
		// two historical denials; no fallback reason is ever fabricated.
		throw new SiblingVariantUnavailableError(eligibility.reason);
	}

	const context = target.historicalContext;
	if (context === null) {
		// Unreachable after the eligibility check; keeps the pair trusted.
		throw new SiblingVariantUnavailableError("missing-historical-context");
	}
	const human = snapshot.cast.find(
		(participant) => participant.id === context.humanParticipantId,
	);
	const model = snapshot.cast.find(
		(participant) => participant.id === context.modelParticipantId,
	);
	if (human === undefined || model === undefined) {
		throw new SiblingVariantUnavailableError(
			"historical-participant-unavailable",
		);
	}

	// Selected history strictly preceding the target Message. Excluding the
	// target by construction also excludes all of its existing sibling
	// Variants: an alternative never prompts on another alternative.
	const history = selectedHistoryFrom(snapshot, targetIndex);

	// The historical pair's current Definitions and names, so a rename or
	// Prompt edit before this generation starts contributes; the Message
	// itself keeps displaying its captured author name.
	const plan = compilePrompt({
		human: toCompilerDefinition(human),
		model: toCompilerDefinition(model),
		history,
	});

	return { plan };
};

// Targeted Swipe: generates a new sibling Variant for an existing native
// Message using the historical Control pair captured when that Message was
// generated or its openings were configured. The historical pair's current
// Definitions and names compile the plan; current generation settings and
// the selected history preceding the target Message complete it. The commit
// appends the sibling without changing current Control or the Author Stamp.
export async function generateSiblingVariant(
	database: Database,
	input: GenerateSiblingVariantInput,
): Promise<ConversationSnapshot> {
	const conversation = createConversationModule(database);

	// Generation-start capture: one authoritative snapshot derives the plan
	// from the target Message's historical pair; concurrent edits land and
	// affect only later sibling generations.
	const snapshot = conversation.getSnapshot(input.conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(input.conversationId);
	}
	const { plan } = deriveSiblingDerivation(snapshot, input.messageId);
	const capture = captureGenerationSettings(
		database,
		input.conversationId,
		input.connection,
		input.connectionSettings,
	);

	const content = await collectModelClientContent(input.modelClient, {
		promptPlan: plan,
		modelId: capture.settings.modelId,
		generationSettings: toModelClientGenerationSettings(capture.settings),
		connection: capture.connection,
	});

	return conversation.commitSiblingVariant({
		conversationId: input.conversationId,
		messageId: input.messageId,
		timestamp: input.timestamp ?? new Date().toISOString(),
		content,
		provenance: capture.provenance,
	});
}

interface GenerationCapture {
	settings: ConversationGenerationSettings;
	connection: ModelClientConnectionSnapshot | null;
	provenance: ConversationDataEntry;
}
