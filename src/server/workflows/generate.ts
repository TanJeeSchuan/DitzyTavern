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
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { activeGenerationTable } from "../database/schema";
import {
	createConversationModule,
	ConversationNotPlayableError,
	ConversationNotFoundError,
	ContinuationUnavailableError,
	deriveMessageSwipeEligibility,
	InvalidConversationCommandError,
	StaleConversationRevisionError,
	SiblingVariantUnavailableError,
	type ConversationDataEntry,
	type ConversationSnapshot,
	type AcceptedTailGeneration,
	type AcceptedContinuationGeneration,
	type AcceptedSiblingGeneration,
	type ConversationJsonValue,
} from "../conversation";
import {
	assertPromptBudget,
	budgetPromptPlan,
	compilePrompt,
	type PromptHistoryEntry,
	type PromptBudgetFailure,
	type PromptBudgetResult,
	type PromptPlan,
	type GenerationIntent,
	type TokenEstimator,
} from "../prompt-compiler";
import type { CastParticipantSnapshot } from "../conversation/types";
import {
	collectModelClientGeneration,
	ModelClientGenerationError,
	type AssistantPrefill,
	type ModelClientConnectionSnapshot,
	type ModelClientEvent,
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
	// The selected Continue request intent is exposed separately from the
	// ordinary Generate plan. Assistant prefill remains metadata here, never a
	// synthetic Conversation history block.
	continuationIntent: GenerationIntent | null;
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
	protectedHistoryIndex?: number;
}

export interface GenerationCoordinator {
	// Runs the existing Tail Generation behavior. The Model Client remains an
	// injected dependency, so this seam can be controlled without provider
	// traffic in workflow and contract tests.
	generate(input: GenerateReplyInput): Promise<ConversationSnapshot>;
	// Revisioned Send acceptance with a server-owned provisional Tail target.
	send(input: SendThroughProvisionalTailGenerationInput): Promise<SendThroughProvisionalTailGenerationResult>;
}

export interface SendThroughProvisionalTailGenerationInput extends GenerateReplyInput {
	// Send is a revisioned acceptance operation. The submitted text is
	// included in Prompt preflight before the server writes either Message.
	expectedRevision: number;
	content: string;
	// Fired immediately after the accepted human/provisional target
	// transaction commits and before provider contact begins.
	onAccepted?: (accepted: AcceptedTailGeneration) => void | Promise<void>;
}

export interface SendThroughProvisionalTailGenerationResult {
	conversation: ConversationSnapshot;
	generationId: number;
	humanMessageId: number;
	modelMessageId: number;
	provisionalVariantId: number;
}

export interface ServerOwnedSendGeneration {
	/** Resolves as soon as the provisional target is committed. */
	readonly accepted: Promise<AcceptedTailGeneration>;
	/** Resolves/rejects when the provider attempt and terminal commit finish. */
	readonly result: Promise<SendThroughProvisionalTailGenerationResult>;
	/** Cancellation owned by the generation, never by an observing request. */
	readonly signal: AbortSignal;
}

export interface ServerOwnedSendGenerationCallbacks {
	onAccepted?: (accepted: AcceptedTailGeneration, control: ServerOwnedGenerationControl) => void | Promise<void>;
	onEvent?: (event: ModelClientEvent) => void | Promise<void>;
}

/** Provider cancellation handle passed only to the server-owned runtime seam. */
export interface ServerOwnedGenerationControl {
	readonly signal: AbortSignal;
	stop(): void;
}

export function createGenerationCoordinator(
	database: Database,
): GenerationCoordinator {
	return {
		generate: (input) => executeTailGeneration(database, input),
		send: (input) => sendThroughProvisionalTailGeneration(database, input),
	};
}

// Starts Send as a detached server-owned attempt. The caller receives an
// acceptance promise separately from the terminal result and may attach zero
// or more observers to the generation runtime in between. In particular, the
// caller's HTTP AbortSignal is intentionally not forwarded to the provider.
export function startServerOwnedSendGeneration(
	database: Database,
	input: SendThroughProvisionalTailGenerationInput,
	callbacks: ServerOwnedSendGenerationCallbacks = {},
): ServerOwnedSendGeneration {
	const controller = new AbortController();
	let accepted = false;
	let resolveAccepted!: (value: AcceptedTailGeneration) => void;
	let rejectAccepted!: (reason: Error) => void;
	const acceptedPromise = new Promise<AcceptedTailGeneration>((resolve, reject) => {
		resolveAccepted = resolve;
		rejectAccepted = reject;
	});
	const result = sendThroughProvisionalTailGeneration(database, {
		...input,
		signal: controller.signal,
			onAccepted: async (value) => {
				accepted = true;
				resolveAccepted(value);
				await callbacks.onAccepted?.(value, { signal: controller.signal, stop: () => controller.abort() });
		},
		onEvent: async (event) => {
			await input.onEvent?.(event);
			await callbacks.onEvent?.(event);
		},
	});
	void result.catch((error) => {
		if (!accepted) rejectAccepted(error instanceof Error ? error : new Error("Generation could not be accepted."));
	});
	return { accepted: acceptedPromise, result, signal: controller.signal };
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
	roleForMessage: (
		message: ConversationSnapshot["messages"][number],
	) => "human" | "model" | null = (message) =>
		message.author?.participantId === humanParticipantId
			? "human"
			: message.author?.participantId === modelParticipantId
				? "model"
				: null,
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
		roles.push(roleForMessage(message));
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
		protectedHistoryIndex: derivation.protectedHistoryIndex,
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
			continuationIntent: null,
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
	const continuationIntent: GenerationIntent = settings.continuationStrategy === "instruction"
		? {
			type: "continuation",
			strategy: "instruction",
			instruction: settings.continuationInstruction,
		}
		: {
			type: "continuation",
			strategy: "assistant-prefill",
			suffix: settings.continuationPrefillSuffix,
		};

	return {
		conversationId,
		playable: true,
		humanParticipant: derivation.humanParticipant,
		modelParticipant: derivation.modelParticipant,
		plan: budget.plan,
		continuationIntent,
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

interface SendGenerationCapture extends CapturedGeneration {
	humanContent: string;
	reuseHumanMessageId: number | undefined;
}

// Active Generation persistence stores only a closed JSON projection of the
// provider-neutral captures. These explicit projections keep provider and
// class instances out of the Conversation domain boundary.
const promptPlanJson = (plan: PromptPlan): ConversationJsonValue => {
	const result = {
		blocks: plan.blocks.map((block): ConversationJsonValue => block.kind === "identity"
			? { kind: block.kind, role: block.role, content: block.content }
			: block.kind === "history"
				? { kind: block.kind, speakerName: block.speakerName, content: block.content }
				: { kind: block.kind, content: block.content }),
		warnings: plan.warnings.map((warning) => ({
			block: warning.block,
			macro: warning.macro,
		})),
	} satisfies ConversationJsonValue;
	return plan.intent === undefined ? result : { ...result, intent: plan.intent };
};

const generationSettingsJson = (
	settings: ModelClientGenerationSettings & {
		readonly modelId?: string;
		readonly siblingGenerationLimit?: number;
		readonly continuationStrategy?: string | null;
		readonly continuationInstruction?: string | null;
		readonly continuationPrefillSuffix?: string | null;
	},
): ConversationJsonValue => ({
	modelId: settings.modelId ?? null,
	siblingGenerationLimit: settings.siblingGenerationLimit ?? null,
	temperature: settings.temperature,
	topP: settings.topP,
	frequencyPenalty: settings.frequencyPenalty,
	presencePenalty: settings.presencePenalty,
	contextLimit: settings.contextLimit,
	responseBudget: settings.responseBudget,
	continuationStrategy: settings.continuationStrategy ?? null,
	continuationInstruction: settings.continuationInstruction ?? null,
	continuationPrefillSuffix: settings.continuationPrefillSuffix ?? null,
	requestOverrides: settings.requestOverrides,
});

const connectionJson = (
	connection: ModelClientConnectionSnapshot | null,
): ConversationJsonValue => connection === null
	? null
	: {
			profileId: connection.profileId,
			settingsRevision: connection.settingsRevision,
			backend: connection.backend,
			adapter: connection.adapter,
		};

// Build the candidate Prompt Plan without writing it. A retry reuses the
// already accepted trailing human Message; a fresh Send appends the submitted
// human writing to the selected narrative path before budgeting.
function captureSendGeneration(
	database: Database,
	snapshot: ConversationSnapshot,
	content: string,
	connection: ModelClientConnectionSnapshot | null | undefined,
	connectionSettingsOptions: ConnectionSettingsModuleOptions | undefined,
	tokenEstimator: TokenEstimator | undefined,
): SendGenerationCapture {
	const settingsCapture = captureGenerationSettings(
		database,
		snapshot.id,
		connection,
		connectionSettingsOptions,
	);
	const derivation = deriveGeneration(snapshot);
	if (derivation === null) throw new ConversationNotPlayableError(snapshot.id);

	const latest = snapshot.messages.at(-1);
	const latestSelected = latest?.variants.find((variant) => variant.selected);
	const reuseHumanMessageId = latest !== undefined &&
		latest.author?.participantId === derivation.humanParticipant.id &&
		latestSelected?.content === content
		? latest.id
		: undefined;
	const history = reuseHumanMessageId === undefined
		? [...derivation.history, {
			speakerName: derivation.humanParticipant.name,
			content,
		}]
		: derivation.history;
	const historyRoles = reuseHumanMessageId === undefined
		? [...derivation.historyRoles, "human" as const]
		: derivation.historyRoles;
	const plan = derivation.compile(history);
	const candidate: GenerationDerivation = {
		...derivation,
		plan,
		history,
		historyRoles,
	};
	const budget = assertPromptBudget(
		createBudgetedPlan(candidate, settingsCapture.settings, tokenEstimator),
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
		humanContent: content,
		reuseHumanMessageId,
	};
}

// Send's accepted lifecycle is intentionally separate from the legacy
// Generate wrapper. Preflight is entirely read-only; only after it succeeds
// does the Conversation seam atomically create the human input, provisional
// model target, and Active Generation before this function contacts a Model
// Client.
export async function sendThroughProvisionalTailGeneration(
	database: Database,
	input: SendThroughProvisionalTailGenerationInput,
): Promise<SendThroughProvisionalTailGenerationResult> {
	if (input.content.trim() === "") {
		throw new InvalidConversationCommandError(
			"Send requires non-empty composer content.",
		);
	}
	const conversation = createConversationModule(database);
	const snapshot = conversation.getSnapshot(input.conversationId);
	if (snapshot === undefined) throw new ConversationNotFoundError(input.conversationId);
	if (snapshot.revision !== input.expectedRevision) {
		throw new StaleConversationRevisionError(
			input.expectedRevision,
			snapshot.revision,
		);
	}
	const capture = captureSendGeneration(
		database,
		snapshot,
		input.content,
		input.connection,
		input.connectionSettings,
		input.tokenEstimator,
	);
	const timestamp = input.timestamp ?? new Date().toISOString();
	const accepted = conversation.acceptTailGeneration({
		conversationId: input.conversationId,
		expectedRevision: input.expectedRevision,
		timestamp,
		humanContent: capture.humanContent,
		reuseHumanMessageId: capture.reuseHumanMessageId,
		humanParticipantId: capture.control.humanParticipantId,
		modelParticipantId: capture.control.modelParticipantId,
		capturedModelName: capture.author.capturedName,
		promptPlan: promptPlanJson(capture.promptPlan),
		historyRoles: capture.historyRoles,
		generationSettings: generationSettingsJson({
			modelId: capture.settings.modelId,
			siblingGenerationLimit: capture.settings.siblingGenerationLimit,
			continuationStrategy: capture.settings.continuationStrategy,
			continuationInstruction: capture.settings.continuationInstruction,
			continuationPrefillSuffix: capture.settings.continuationPrefillSuffix,
			...toModelClientGenerationSettings(capture.settings),
		}),
		connection: connectionJson(capture.connection),
		provenance: capture.provenance,
	});
	try {
		await input.onAccepted?.(accepted);
	} catch {
		// Acceptance is authoritative even when an observing transport has
		// disconnected. Continue the server-owned provider attempt.
	}

	try {
		const outcome = await runGeneration(input.modelClient, {
			promptPlan: capture.promptPlan,
			historyRoles: capture.historyRoles,
			modelId: capture.settings.modelId,
			generationSettings: toModelClientGenerationSettings(capture.settings),
			connection: capture.connection,
			signal: input.signal,
		}, input.onEvent);
		if (outcome.content.length === 0 && outcome.reasoning.length === 0) {
			conversation.removeTailGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
			});
			throw new ModelClientGenerationError(
				"provider",
				"Generation produced no usable output.",
			);
		}
		const committed = conversation.resolveTailGeneration({
			conversationId: input.conversationId,
			generationId: accepted.generationId,
			timestamp,
			content: outcome.content,
			data: generationOutcomeData(outcome),
		});
		return {
			conversation: committed,
			generationId: accepted.generationId,
			humanMessageId: accepted.humanMessageId,
			modelMessageId: accepted.modelMessageId,
			provisionalVariantId: accepted.provisionalVariantId,
		};
	} catch (error) {
		// Visible provider failures are converted by runGeneration into an
		// interrupted outcome and resolve normally. All zero-output failures,
		// including unexpected transport errors, clean up only the target.
		if (error instanceof ModelClientGenerationError) {
			const partial = error.partial;
			if ((partial.content ?? "").length > 0 || (partial.reasoning ?? "").length > 0) {
				throw error;
			}
		}
		try {
			conversation.removeTailGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
			});
		} catch {
			// Preserve the provider error; a later recovery sweep can remove an
			// orphaned target if the process failed during cleanup.
		}
		throw error;
	}
}

// Short workflow spelling for callers that describe the operation as Send.
export const sendMessage = sendThroughProvisionalTailGeneration;

export interface ContinueGenerationInput extends GenerateReplyInput {
	// Continue is a revisioned acceptance operation. The selected terminal
	// model Message and Variant are captured so a changed narrative position
	// cannot receive output from this attempt.
	expectedRevision: number;
	onAccepted?: (accepted: AcceptedContinuationGeneration) => void | Promise<void>;
}

export interface ContinueGenerationResult {
	conversation: ConversationSnapshot;
	generationId: number;
	modelMessageId: number;
	provisionalVariantId: number;
}

export interface ServerOwnedContinuationGeneration {
	readonly accepted: Promise<AcceptedContinuationGeneration>;
	readonly result: Promise<ContinueGenerationResult>;
	readonly signal: AbortSignal;
}

export interface ServerOwnedContinuationGenerationCallbacks {
	onAccepted?: (accepted: AcceptedContinuationGeneration, control: ServerOwnedGenerationControl) => void | Promise<void>;
	onEvent?: (event: ModelClientEvent) => void | Promise<void>;
}

interface ContinuationGenerationCapture extends CapturedGeneration {
	precedingMessageId: number;
	precedingVariantId: number;
	intent: GenerationIntent;
	assistantPrefill?: AssistantPrefill;
}

const isActiveGeneration = (database: Database, conversationId: number): boolean =>
	drizzle(database)
		.select({ id: activeGenerationTable.id })
		.from(activeGenerationTable)
		.where(eq(activeGenerationTable.chat_id, conversationId))
		.get() !== undefined;

function continuationHasUsableOutput(
	variant: ConversationSnapshot["messages"][number]["variants"][number],
): boolean {
	if (variant.content.length > 0) return true;
	return variant.data.some(
		(entry) => entry.namespace === "generation" &&
			entry.key === "reasoning" &&
			entry.value.length > 0,
	);
}

function captureContinuationGeneration(
	database: Database,
	snapshot: ConversationSnapshot,
	connection: ModelClientConnectionSnapshot | null | undefined,
	connectionSettingsOptions: ConnectionSettingsModuleOptions | undefined,
	tokenEstimator: TokenEstimator | undefined,
): ContinuationGenerationCapture {
	if (isActiveGeneration(database, snapshot.id)) {
		throw new ContinuationUnavailableError("active-generation");
	}
	if (!snapshot.playable) throw new ConversationNotPlayableError(snapshot.id);
	const latest = snapshot.messages.at(-1);
	const selected = latest?.variants.find((variant) => variant.selected);
	const modelParticipantId = snapshot.control.modelParticipantId;
	const latestWasModelAuthored = latest?.author?.participantId !== null &&
		latest?.author?.participantId !== undefined &&
		(modelParticipantId === latest.author.participantId ||
			latest.historicalContext?.modelParticipantId === latest.author.participantId);
	if (
		latest === undefined ||
		selected === undefined ||
		modelParticipantId === null ||
		!latestWasModelAuthored ||
		!continuationHasUsableOutput(selected)
	) {
		throw new ContinuationUnavailableError("not-terminal-model-message");
	}
	const derivation = deriveGeneration(snapshot);
	if (derivation === null) throw new ConversationNotPlayableError(snapshot.id);
	const settingsCapture = captureGenerationSettings(
		database,
		snapshot.id,
		connection,
		connectionSettingsOptions,
	);
	if (settingsCapture.settings.continuationStrategy !== "instruction") {
		if (selected.content.length === 0) {
			throw new ContinuationUnavailableError("assistant-prefill-requires-visible-text");
		}
	}
	const intent: GenerationIntent = settingsCapture.settings.continuationStrategy === "instruction"
		? {
			type: "continuation",
			strategy: "instruction",
			instruction: settingsCapture.settings.continuationInstruction,
		}
		: {
			type: "continuation",
			strategy: "assistant-prefill",
			suffix: settingsCapture.settings.continuationPrefillSuffix,
		};
	const compile = (history: readonly PromptHistoryEntry[]) => ({
		...derivation.compile(history),
		intent,
	});
	// A prior model Message can have been authored by the Participant who held
	// model Control at that time. Preserve that role in the continuation's
	// provider input even when the current model Control has moved on.
	const continuationHistory = selectedHistoryFrom(
		snapshot,
		derivation.humanParticipant.id,
		derivation.modelParticipant.id,
		undefined,
		(message) => {
			const authorId = message.author?.participantId;
			if (
				message.historicalContext?.modelParticipantId === authorId ||
				authorId === derivation.modelParticipant.id
			) {
				return "model";
			}
			if (
				message.historicalContext?.humanParticipantId === authorId ||
				authorId === derivation.humanParticipant.id
			) {
				return "human";
			}
			return null;
		},
	);
	const continuationDerivation: GenerationDerivation = {
		...derivation,
		historyRoles: continuationHistory.roles,
		plan: compile(derivation.history),
		compile,
		protectedHistoryIndex: settingsCapture.settings.continuationStrategy === "assistant-prefill"
			? continuationHistory.entries.length - 1
			: undefined,
	};
	const budget = assertPromptBudget(
		createBudgetedPlan(continuationDerivation, settingsCapture.settings, tokenEstimator),
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
		precedingMessageId: latest.id,
		precedingVariantId: selected.id,
		intent,
		assistantPrefill: settingsCapture.settings.continuationStrategy === "assistant-prefill"
			? {
				prefix: selected.content,
				suffix: settingsCapture.settings.continuationPrefillSuffix,
			}
			: undefined,
	};
}

// Continue starts from the selected narrative path and persists an ordinary
// model-authored Message. It shares the same normalized stream, terminal
// outcome, and provisional cleanup behavior as Send, but never inserts a
// Human-authored Message.
export async function continueGeneration(
	database: Database,
	input: ContinueGenerationInput,
): Promise<ContinueGenerationResult> {
	const conversation = createConversationModule(database);
	const snapshot = conversation.getSnapshot(input.conversationId);
	if (snapshot === undefined) throw new ConversationNotFoundError(input.conversationId);
	if (snapshot.revision !== input.expectedRevision) {
		throw new StaleConversationRevisionError(input.expectedRevision, snapshot.revision);
	}
	const capture = captureContinuationGeneration(
		database,
		snapshot,
		input.connection,
		input.connectionSettings,
		input.tokenEstimator,
	);
	const timestamp = input.timestamp ?? new Date().toISOString();
	const accepted = conversation.acceptContinuationGeneration({
		conversationId: input.conversationId,
		expectedRevision: input.expectedRevision,
		timestamp,
		precedingMessageId: capture.precedingMessageId,
		precedingVariantId: capture.precedingVariantId,
		humanParticipantId: capture.control.humanParticipantId,
		modelParticipantId: capture.control.modelParticipantId,
		capturedModelName: capture.author.capturedName,
		promptPlan: promptPlanJson(capture.promptPlan),
		historyRoles: capture.historyRoles,
		generationSettings: generationSettingsJson({
			modelId: capture.settings.modelId,
			siblingGenerationLimit: capture.settings.siblingGenerationLimit,
			continuationStrategy: capture.settings.continuationStrategy,
			continuationInstruction: capture.settings.continuationInstruction,
			continuationPrefillSuffix: capture.settings.continuationPrefillSuffix,
			...toModelClientGenerationSettings(capture.settings),
		}),
		connection: connectionJson(capture.connection),
		generationIntent: capture.intent,
		provenance: capture.provenance,
	});
	try {
		await input.onAccepted?.(accepted);
	} catch {
		// Acceptance is authoritative even when the observing caller disconnects.
	}
	try {
		const outcome = await runGeneration(input.modelClient, {
		promptPlan: capture.promptPlan,
		historyRoles: capture.historyRoles,
		modelId: capture.settings.modelId,
		generationSettings: toModelClientGenerationSettings(capture.settings),
		assistantPrefill: capture.assistantPrefill,
		connection: capture.connection,
			signal: input.signal,
		}, input.onEvent);
		if (outcome.content.length === 0 && outcome.reasoning.length === 0) {
			conversation.removeTailGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
			});
			throw new ModelClientGenerationError(
				"provider",
				"Generation produced no usable output.",
			);
		}
		const committed = conversation.resolveTailGeneration({
			conversationId: input.conversationId,
			generationId: accepted.generationId,
			timestamp,
			content: outcome.content,
			data: [
				{ namespace: "generation", key: "intent", value: JSON.stringify(capture.intent) },
				...generationOutcomeData(outcome),
			],
		});
		return {
			conversation: committed,
			generationId: accepted.generationId,
			modelMessageId: accepted.modelMessageId,
			provisionalVariantId: accepted.provisionalVariantId,
		};
	} catch (error) {
		if (error instanceof ModelClientGenerationError) {
			const partial = error.partial;
			if ((partial.content ?? "").length > 0 || (partial.reasoning ?? "").length > 0) {
				// Visible partial output is durable only when the provisional target is
				// resolved. runGeneration normally handles this; this guard is for a
				// future collector that may rethrow a partial provider failure.
				if ((partial.content ?? "").length > 0 || (partial.reasoning ?? "").length > 0) {
					const committed = conversation.resolveTailGeneration({
						conversationId: input.conversationId,
						generationId: accepted.generationId,
						timestamp,
						content: partial.content ?? "",
						data: [
							{ namespace: "generation", key: "intent", value: JSON.stringify(capture.intent) },
							{ namespace: "generation", key: "outcome", value: "interrupted" },
							...(partial.reasoning === undefined || partial.reasoning.length === 0
								? []
								: [{ namespace: "generation", key: "reasoning", value: partial.reasoning }]),
						],
					});
					return {
						conversation: committed,
						generationId: accepted.generationId,
						modelMessageId: accepted.modelMessageId,
						provisionalVariantId: accepted.provisionalVariantId,
					};
				}
			}
		}
		try {
			conversation.removeTailGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
			});
		} catch {
			// Preserve the provider error; recovery can clean an orphan later.
		}
		throw error;
	}
}

export const generateContinuation = continueGeneration;
export const continueConversation = continueGeneration;

export function startServerOwnedContinuationGeneration(
	database: Database,
	input: ContinueGenerationInput,
	callbacks: ServerOwnedContinuationGenerationCallbacks = {},
): ServerOwnedContinuationGeneration {
	const controller = new AbortController();
	let accepted = false;
	let resolveAccepted!: (value: AcceptedContinuationGeneration) => void;
	let rejectAccepted!: (reason: Error) => void;
	const acceptedPromise = new Promise<AcceptedContinuationGeneration>((resolve, reject) => {
		resolveAccepted = resolve;
		rejectAccepted = reject;
	});
	const result = continueGeneration(database, {
		...input,
		signal: controller.signal,
		onAccepted: async (value) => {
			accepted = true;
			resolveAccepted(value);
			await callbacks.onAccepted?.(value, { signal: controller.signal, stop: () => controller.abort() });
		},
		onEvent: async (event) => {
			await input.onEvent?.(event);
			await callbacks.onEvent?.(event);
		},
	});
	void result.catch((error) => {
		if (!accepted) rejectAccepted(error instanceof Error ? error : new Error("Generation could not be accepted."));
	});
	return { accepted: acceptedPromise, result, signal: controller.signal };
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
	onAccepted?: (accepted: AcceptedSiblingGeneration) => void | Promise<void>;
	tokenEstimator?: TokenEstimator;
	// Optional explicit write time; defaults to the current wall clock.
	timestamp?: string | undefined;
}

export interface SiblingGenerationResult {
	conversation: ConversationSnapshot;
	generationId: number;
	messageId: number;
	provisionalVariantId: number;
}

export interface ServerOwnedSiblingGeneration {
	readonly accepted: Promise<AcceptedSiblingGeneration>;
	readonly result: Promise<SiblingGenerationResult>;
	readonly signal: AbortSignal;
}

export interface ServerOwnedSiblingGenerationCallbacks {
	onAccepted?: (accepted: AcceptedSiblingGeneration, control: ServerOwnedGenerationControl) => void | Promise<void>;
	onEvent?: (event: ModelClientEvent) => void | Promise<void>;
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

interface SiblingGenerationCapture {
	readonly promptPlan: PromptPlan;
	readonly historyRoles: readonly ("human" | "model" | null)[];
	readonly humanParticipant: ParticipantPreview;
	readonly modelParticipant: ParticipantPreview;
	readonly humanParticipantId: number;
	readonly modelParticipantId: number;
	readonly priorVariantId: number | null;
	readonly settings: ConversationGenerationSettings;
	readonly connection: ModelClientConnectionSnapshot | null;
	readonly provenance: ConversationDataEntry;
}

function captureSiblingGeneration(
	database: Database,
	snapshot: ConversationSnapshot,
	input: GenerateSiblingVariantInput,
): SiblingGenerationCapture {
	const derivation = deriveSiblingDerivation(snapshot, input.messageId);
	const settingsCapture = captureGenerationSettings(
		database,
		snapshot.id,
		input.connection,
		input.connectionSettings,
	);
	const budget = assertPromptBudget(
		createBudgetedPlan(derivation, settingsCapture.settings, input.tokenEstimator),
	);
	const target = snapshot.messages.find((message) => message.id === input.messageId);
	const priorVariantId = target?.variants.find((variant) => variant.selected)?.id ?? null;
	return {
		promptPlan: { ...budget.plan, intent: { type: "sibling" } },
		historyRoles: budget.retainedHistoryRoles,
		humanParticipant: derivation.humanParticipant,
		modelParticipant: derivation.modelParticipant,
		humanParticipantId: derivation.humanParticipant.id,
		modelParticipantId: derivation.modelParticipant.id,
		priorVariantId,
		settings: settingsCapture.settings,
		connection: settingsCapture.connection,
		provenance: settingsCapture.provenance,
	};
}

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
	const capture = captureSiblingGeneration(database, snapshot, input);
	const timestamp = input.timestamp ?? new Date().toISOString();
	const accepted = conversation.acceptSiblingGeneration({
		conversationId: input.conversationId,
		messageId: input.messageId,
		timestamp,
		humanParticipantId: capture.humanParticipantId,
		modelParticipantId: capture.modelParticipantId,
		capturedModelName: capture.modelParticipant.name,
		promptPlan: promptPlanJson(capture.promptPlan),
		historyRoles: capture.historyRoles,
		generationSettings: generationSettingsJson({
			modelId: capture.settings.modelId,
			siblingGenerationLimit: capture.settings.siblingGenerationLimit,
			continuationStrategy: capture.settings.continuationStrategy,
			continuationInstruction: capture.settings.continuationInstruction,
			...toModelClientGenerationSettings(capture.settings),
		}),
		connection: connectionJson(capture.connection),
		generationIntent: { type: "sibling" },
		provenance: capture.provenance,
	});
	try {
		await input.onAccepted?.(accepted);
	} catch {
		// Acceptance is authoritative even if an observer disconnects while
		// the provider request is being started.
	}
	try {
		const outcome = await runGeneration(input.modelClient, {
			promptPlan: capture.promptPlan,
			historyRoles: capture.historyRoles,
			modelId: capture.settings.modelId,
			generationSettings: toModelClientGenerationSettings(capture.settings),
			connection: capture.connection,
			signal: input.signal,
		}, input.onEvent);
		if (outcome.content.length === 0 && outcome.reasoning.length === 0) {
			conversation.removeSiblingGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
			});
			throw new ModelClientGenerationError("provider", "Generation produced no usable output.");
		}
		return conversation.resolveSiblingGeneration({
			conversationId: input.conversationId,
			generationId: accepted.generationId,
			timestamp,
			content: outcome.content,
			data: generationOutcomeData(outcome),
		});
	} catch (error) {
		try {
			conversation.removeSiblingGeneration({
				conversationId: input.conversationId,
				generationId: accepted.generationId,
			});
		} catch {
			// Preserve the provider error; a later recovery sweep can clean an
			// orphaned provisional sibling target.
		}
		throw error;
	}
}

// Detached server-owned Sibling Generation. The acceptance promise resolves
// before provider contact so several attempts can be started and observed
// independently without coupling work to one HTTP subscriber.
export function startServerOwnedSiblingGeneration(
	database: Database,
	input: GenerateSiblingVariantInput,
	callbacks: ServerOwnedSiblingGenerationCallbacks = {},
): ServerOwnedSiblingGeneration {
	const controller = new AbortController();
	let accepted = false;
	let resolveAccepted!: (value: AcceptedSiblingGeneration) => void;
	let rejectAccepted!: (reason: Error) => void;
	const acceptedPromise = new Promise<AcceptedSiblingGeneration>((resolve, reject) => {
		resolveAccepted = resolve;
		rejectAccepted = reject;
	});
	const generationResult = generateSiblingVariant(database, {
		...input,
		signal: controller.signal,
		onAccepted: async (value) => {
			accepted = true;
			resolveAccepted(value);
			await callbacks.onAccepted?.(value, { signal: controller.signal, stop: () => controller.abort() });
		},
		onEvent: async (event) => {
			await input.onEvent?.(event);
			await callbacks.onEvent?.(event);
		},
	});
	const result = generationResult.then(async (conversation) => {
		const acceptedValue = await acceptedPromise;
		return {
			conversation,
			generationId: acceptedValue.generationId,
			messageId: acceptedValue.messageId,
			provisionalVariantId: acceptedValue.provisionalVariantId,
		};
	});
	void generationResult.catch((error) => {
		if (!accepted) rejectAccepted(error instanceof Error ? error : new Error("Generation could not be accepted."));
	});
	return { accepted: acceptedPromise, result, signal: controller.signal };
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
