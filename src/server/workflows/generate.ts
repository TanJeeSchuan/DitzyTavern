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
	type ConversationDataEntry,
	type ConversationSnapshot,
} from "../conversation";
import {
	assertPromptBudget,
	budgetPromptPlan,
	compilePrompt,
	type PromptHistoryEntry,
	type PromptBudgetFailure,
	type PromptBudgetResult,
	type PromptPlan,
	type TokenEstimator,
} from "../prompt-compiler";
import type { CastParticipantSnapshot } from "../conversation/types";
import {
	collectModelClientGeneration,
	ModelClientGenerationError,
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
	tokenEstimate: number | null;
	responseBudget: number | null;
	safetyAllowance: number | null;
	contextLimit: number | null;
	totalRequiredTokens: number | null;
	omittedHistory: readonly PromptHistoryEntry[];
	budgetFits: boolean | null;
	tokenEstimateIsApproximate: boolean;
	budgetFailure: PromptBudgetFailure | null;
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
	// The signal belongs to this one Generation. A cancelled attempt never
	// changes the active Profile or another Conversation.
	signal?: AbortSignal;
	onEvent?: (event: import("../model-client").ModelClientEvent) => void | Promise<void>;
	// Tests and future calibration work may replace the default project-owned
	// estimator without allowing a provider to influence budgeting policy.
	tokenEstimator?: TokenEstimator;
	// Optional explicit write time; defaults to the current wall clock.
	timestamp?: string | undefined;
}

interface GenerationDerivation {
	plan: PromptPlan;
	history: readonly PromptHistoryEntry[];
	historyRoles: readonly ("human" | "model" | null)[];
	humanParticipant: ParticipantPreview;
	modelParticipant: ParticipantPreview;
	compile: (history: readonly PromptHistoryEntry[]) => PromptPlan;
}

export interface GenerationCoordinator {
	// Runs the existing Tail Generation behavior. The Model Client remains an
	// injected dependency, so this seam can be controlled without provider
	// traffic in workflow and contract tests.
	generate(input: GenerateReplyInput): Promise<ConversationSnapshot>;
}

export function createGenerationCoordinator(
	database: Database,
): GenerationCoordinator {
	return {
		generate: (input) => executeTailGeneration(database, input),
	};
}

interface SelectedHistory {
	entries: readonly PromptHistoryEntry[];
	roles: readonly ("human" | "model" | null)[];
}

// Selected-history entries for prompt compilation, derived from each
// Message's selected Variant and its immutable Author Stamp name.
// `endExclusiveIndex` limits the entries to Messages strictly preceding a
// targeted sibling Variant; omitted, the entire ordered snapshot counts, as
// a current Generate at the tail uses.
const selectedHistoryFrom = (
	snapshot: ConversationSnapshot,
	humanParticipantId: number,
	modelParticipantId: number,
	endExclusiveIndex?: number,
): SelectedHistory => {
	const entries: PromptHistoryEntry[] = [];
	const roles: ("human" | "model" | null)[] = [];

	for (const message of snapshot.messages.slice(0, endExclusiveIndex)) {
		const selected = message.variants.find((variant) => variant.selected);
		if (selected === undefined) continue;

		entries.push({
			speakerName: message.author?.capturedName ?? null,
			content: selected.content,
		});
		roles.push(
			message.author?.participantId === humanParticipantId
				? "human"
				: message.author?.participantId === modelParticipantId
					? "model"
					: null,
		);
	}

	return { entries, roles };
};

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

	const selectedHistory = selectedHistoryFrom(snapshot, human.id, model.id);
	const compile = (history: readonly PromptHistoryEntry[]) => compilePrompt({
		human: toCompilerDefinition(human),
		model: toCompilerDefinition(model),
		history,
	});
	const plan = compile(selectedHistory.entries);

	return {
		plan,
		history: selectedHistory.entries,
		historyRoles: selectedHistory.roles,
		humanParticipant: { id: human.id, name: human.name },
		modelParticipant: { id: model.id, name: model.name },
		compile,
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
): GenerationSettingsCapture {
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
				safetyAllowance: settings.safetyAllowance,
				requestOverrides: settings.requestOverrides,
			},
		}),
	} satisfies ConversationDataEntry;
	return { settings, connection: capturedConnection, provenance };
}

interface CapturedGeneration {
	readonly promptPlan: PromptPlan;
	readonly historyRoles: readonly ("human" | "model" | null)[];
	readonly author: {
		readonly participantId: number;
		readonly capturedName: string;
	};
	readonly control: {
		readonly humanParticipantId: number;
		readonly modelParticipantId: number;
	};
	readonly settings: ConversationGenerationSettings;
	readonly connection: ModelClientConnectionSnapshot | null;
	readonly provenance: ConversationDataEntry;
}

function captureGeneration(
	database: Database,
	snapshot: ConversationSnapshot,
	connection: ModelClientConnectionSnapshot | null | undefined,
	connectionSettingsOptions: ConnectionSettingsModuleOptions | undefined,
	tokenEstimator: TokenEstimator | undefined,
): CapturedGeneration {
	const settingsCapture = captureGenerationSettings(
		database,
		snapshot.id,
		connection,
		connectionSettingsOptions,
	);
	const derivation = deriveGeneration(snapshot);
	if (derivation === null) {
		throw new ConversationNotPlayableError(snapshot.id);
	}
	const budget = assertPromptBudget(
		createBudgetedPlan(derivation, settingsCapture.settings, tokenEstimator),
	);
	return {
		promptPlan: budget.plan,
		historyRoles: budget.retainedHistoryRoles,
		author: {
			participantId: derivation.modelParticipant.id,
			capturedName: derivation.modelParticipant.name,
		},
		control: {
			humanParticipantId: derivation.humanParticipant.id,
			modelParticipantId: derivation.modelParticipant.id,
		},
		settings: settingsCapture.settings,
		connection: settingsCapture.connection,
		provenance: settingsCapture.provenance,
	};
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

function createBudgetedPlan(
	derivation: GenerationDerivation,
	settings: ConversationGenerationSettings,
	estimator?: TokenEstimator,
): PromptBudgetResult {
	return budgetPromptPlan({
		plan: derivation.plan,
		compile: derivation.compile,
		history: derivation.history,
		historyRoles: derivation.historyRoles,
		contextLimit: settings.contextLimit,
		responseBudget: settings.responseBudget,
		safetyAllowance: settings.safetyAllowance,
		estimator,
	});
}

type GenerationOutcomeStatus = "complete" | "interrupted" | "length-limited";

interface GenerationOutcome {
	content: string;
	reasoning: string;
	usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
	finishReason: "stop" | "length" | "other" | null;
	rawFinishReason: string | null;
	status: GenerationOutcomeStatus;
	error: string | null;
}

// The transport has one failure policy for both current and sibling
// generations: preserve visible output when a stream fails after producing it,
// but leave zero-output failures to the caller. Keeping that policy here means
// commit paths only decide which Conversation operation receives the outcome.
async function runGeneration(
	modelClient: ModelClient,
	input: Parameters<typeof collectModelClientGeneration>[1],
	onEvent: GenerateReplyInput["onEvent"],
): Promise<GenerationOutcome> {
	try {
		const result = await collectModelClientGeneration(modelClient, input, { onEvent });
		return {
			...result,
			status: result.finishReason === "length" ? "length-limited" : "complete",
			error: null,
		};
	} catch (error) {
		if (!(error instanceof ModelClientGenerationError)) throw error;
		const content = error.partial.content ?? "";
		const reasoning = error.partial.reasoning ?? "";
		if (content.length === 0 && reasoning.length === 0) throw error;

		return {
			content,
			reasoning,
			usage: error.partial.usage ?? null,
			finishReason: null,
			rawFinishReason: null,
			status: "interrupted",
			error: error.kind === "cancelled" ? null : error.message,
		};
	}
}

// Compiles the Prompt Plan the server would send for a current Generate
// without contacting any transport. Exposes the agreed participant context
// (the Control pair and their plan) using provider-neutral vocabulary only.
export function inspectGenerationPrompt(
	database: Database,
	conversationId: number,
	options: { readonly tokenEstimator?: TokenEstimator } = {},
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
			tokenEstimate: null,
			responseBudget: null,
			safetyAllowance: null,
			contextLimit: null,
			totalRequiredTokens: null,
			omittedHistory: [],
			budgetFits: null,
			tokenEstimateIsApproximate: false,
			budgetFailure: null,
		};
	}
	const settings = createConversationModule(database).getGenerationSettings(conversationId);
	if (settings === undefined) {
		throw new ConversationNotFoundError(conversationId);
	}
	const budget = createBudgetedPlan(derivation, settings, options.tokenEstimator);

	return {
		conversationId,
		playable: true,
		humanParticipant: derivation.humanParticipant,
		modelParticipant: derivation.modelParticipant,
		plan: budget.plan,
		tokenEstimate: budget.tokenEstimate,
		responseBudget: budget.responseBudget,
		safetyAllowance: budget.safetyAllowance,
		contextLimit: budget.contextLimit,
		totalRequiredTokens: budget.totalRequiredTokens,
		omittedHistory: budget.omittedHistory,
		budgetFits: budget.fits,
		tokenEstimateIsApproximate: true,
		budgetFailure: budget.failure,
	};
}

async function executeTailGeneration(
	database: Database,
	input: GenerateReplyInput,
): Promise<ConversationSnapshot> {
	const conversation = createConversationModule(database);

	// Capture the complete provider-neutral Generation input before contacting
	// the Model Client. The snapshot and all copied values belong to this one
	// attempt, so later edits affect only later Generations.
	const snapshot = conversation.getSnapshot(input.conversationId);
	if (snapshot === undefined) {
		throw new ConversationNotFoundError(input.conversationId);
	}
	const capture = captureGeneration(
		database,
		snapshot,
		input.connection,
		input.connectionSettings,
		input.tokenEstimator,
	);

	const outcome = await runGeneration(input.modelClient, {
		promptPlan: capture.promptPlan,
		historyRoles: capture.historyRoles,
		modelId: capture.settings.modelId,
		generationSettings: toModelClientGenerationSettings(capture.settings),
		connection: capture.connection,
		signal: input.signal,
	}, input.onEvent);

	// Commit with the generation-start captures even if the Conversation
	// moved on while the transport was working.
	return conversation.commitGeneration({
		conversationId: input.conversationId,
		timestamp: input.timestamp ?? new Date().toISOString(),
		content: outcome.content,
		authorParticipantId: capture.author.participantId,
		capturedAuthorName: capture.author.capturedName,
		humanParticipantId: capture.control.humanParticipantId,
		modelParticipantId: capture.control.modelParticipantId,
		provenance: capture.provenance,
		data: generationOutcomeData(outcome),
	});
}

// Compatibility wrapper for the existing workflow and HTTP callers. New
// server-owned Generation code should depend on the coordinator seam above.
export function generateReply(
	database: Database,
	input: GenerateReplyInput,
): Promise<ConversationSnapshot> {
	return createGenerationCoordinator(database).generate(input);
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
	signal?: AbortSignal;
	onEvent?: (event: import("../model-client").ModelClientEvent) => void | Promise<void>;
	tokenEstimator?: TokenEstimator;
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
	const selectedHistory = selectedHistoryFrom(
		snapshot,
		human.id,
		model.id,
		targetIndex,
	);

	// The historical pair's current Definitions and names, so a rename or
	// Prompt edit before this generation starts contributes; the Message
	// itself keeps displaying its captured author name.
	const compile = (history: readonly PromptHistoryEntry[]) => compilePrompt({
		human: toCompilerDefinition(human),
		model: toCompilerDefinition(model),
		history,
	});
	const plan = compile(selectedHistory.entries);

	return {
		plan,
		history: selectedHistory.entries,
		historyRoles: selectedHistory.roles,
		humanParticipant: { id: human.id, name: human.name },
		modelParticipant: { id: model.id, name: model.name },
		compile,
	};
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
	const derivation = deriveSiblingDerivation(snapshot, input.messageId);
	const capture = captureGenerationSettings(
		database,
		input.conversationId,
		input.connection,
		input.connectionSettings,
	);
	const budget = assertPromptBudget(
		createBudgetedPlan(derivation, capture.settings, input.tokenEstimator),
	);

	const outcome = await runGeneration(input.modelClient, {
		promptPlan: budget.plan,
		historyRoles: budget.retainedHistoryRoles,
		modelId: capture.settings.modelId,
		generationSettings: toModelClientGenerationSettings(capture.settings),
		connection: capture.connection,
		signal: input.signal,
	}, input.onEvent);

	return conversation.commitSiblingVariant({
		conversationId: input.conversationId,
		messageId: input.messageId,
		timestamp: input.timestamp ?? new Date().toISOString(),
		content: outcome.content,
		provenance: capture.provenance,
		data: generationOutcomeData(outcome),
	});
}

function generationOutcomeData(input: GenerationOutcome): ConversationDataEntry[] {
	const data: ConversationDataEntry[] = [];
	if (input.status !== "complete") {
		data.push({ namespace: "generation", key: "outcome", value: input.status });
	}
	if (input.reasoning.length > 0) {
		data.push({ namespace: "generation", key: "reasoning", value: input.reasoning });
	}
	if (input.usage !== null) {
		data.push({
			namespace: "generation",
			key: "usage",
			value: JSON.stringify(normalizeUsage(input.usage)),
		});
	}
	if (input.finishReason === "length" || input.rawFinishReason !== null) {
		data.push({
			namespace: "generation",
			key: "finish",
			value: JSON.stringify({
				reason: input.finishReason,
				raw: input.rawFinishReason?.slice(0, 128) ?? null,
			}),
		});
	}
	if (input.error !== null) {
		data.push({
			namespace: "generation",
			key: "error",
			value: input.error.slice(0, 16_384),
		});
	}
	return data;
}

function normalizeUsage(input: {
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
}) {
	const usage: Record<string, number> = {};
	addUsage(usage, "inputTokens", input.inputTokens);
	addUsage(usage, "outputTokens", input.outputTokens);
	addUsage(usage, "totalTokens", input.totalTokens);
	return usage;
}

function addUsage(target: Record<string, number>, key: string, value: number | undefined): void {
	if (value !== undefined && Number.isFinite(value) && value >= 0) target[key] = value;
}

interface GenerationSettingsCapture {
	settings: ConversationGenerationSettings;
	connection: ModelClientConnectionSnapshot | null;
	provenance: ConversationDataEntry;
}
