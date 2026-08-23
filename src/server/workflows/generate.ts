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
	type ConversationSnapshot,
} from "../conversation";
import {
	compilePrompt,
	type PromptHistoryEntry,
	type PromptPlan,
} from "../prompt-compiler";
import type { CastParticipantSnapshot } from "../conversation/types";

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
	// The model transport seam: given the compiled Prompt Plan, produce the
	// reply text. Callers inject a deterministic fake in tests and the real
	// transport adapter in production; the workflow never calls a provider
	// directly.
	generate: (plan: PromptPlan) => string | Promise<string>;
	// Optional explicit write time; defaults to the current wall clock.
	timestamp?: string | undefined;
}

interface GenerationDerivation {
	plan: PromptPlan;
	humanParticipant: ParticipantPreview;
	modelParticipant: ParticipantPreview;
}

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

	const history: readonly PromptHistoryEntry[] = snapshot.messages.flatMap(
		(message) => {
			const selected = message.variants.find((variant) => variant.selected);
			if (selected === undefined) return [];
			return [
				{
					speakerName: message.author?.capturedName ?? null,
					content: selected.content,
				},
			];
		},
	);

	const plan = compilePrompt({
		human: toCompilerDefinition(human),
		model: toCompilerDefinition(model),
		history,
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

	const content = await input.generate(plan);

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
	});
}