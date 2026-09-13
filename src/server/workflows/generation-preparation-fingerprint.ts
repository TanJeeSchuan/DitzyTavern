import { referencedDefinitionBlocks } from "../prompt-compiler";
import type { PromptPresetSlot } from "../prompt-preset";
import type { CastParticipantSnapshot } from "../conversation/types";
import {
	generationSettingsJson,
	sendReuseTargetOf,
	type GenerationPreparation,
} from "./generate-capture";
import type { GenerationJsonObject, GenerationJsonValue } from "../../shared/generation-json";

const canonicalize = (value: GenerationJsonValue): GenerationJsonValue => {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value === null || Object.prototype.toString.call(value) !== "[object Object]") return value;
	// ==[HUMAN APPROVED]== SAFETY: GenerationJsonValue only permits plain JSON objects at this branch.
	const object = value as GenerationJsonObject;
	return Object.fromEntries(
		Object.entries(object)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonicalize(entry)]),
	);
};

const effectivePreparationSettings = (
	preparation: GenerationPreparation,
): GenerationJsonObject => generationSettingsJson(preparation.effectiveSettings);

const relevantPreparationSources = (preparation: GenerationPreparation) => {
	const channels = {
		human: new Set(),
		model: new Set(),
	} satisfies Record<"human" | "model", Set<keyof CastParticipantSnapshot["prompt"]>>;
	let hasAuthoredSlot = false;
	for (const slot of preparation.recipe.slots) {
		if (!slot.enabled || slot.reference === "history") continue;
		hasAuthoredSlot = true;
		if (slot.reference === "instruction") continue;
		channels[referencedDefinitionBlocks[slot.reference].owner].add(
			referencedDefinitionBlocks[slot.reference].channel,
		);
	}
	if (!hasAuthoredSlot) return [];
	return ([
		["human", preparation.derivation.human],
		["model", preparation.derivation.model],
	] as const).map(([owner, participant]) => ({
		id: participant.id,
		name: participant.name,
		prompt: Object.fromEntries(
			[...channels[owner]].sort().map((channel) => [channel, participant.prompt[channel]]),
		),
	}));
};

const relevantPreparationHistory = (preparation: GenerationPreparation) => {
	if (!preparation.recipe.slots.some((slot) => slot.enabled && slot.reference === "history")) return [];
	return preparation.participation.messages.map((message) => ({
		messageId: message.id,
		position: message.position,
		author: message.author === null ? null : {
			participantId: message.author.participantId,
			capturedName: message.author.capturedName,
		},
		historicalContext: message.historicalContext === null ? null : {
			humanParticipantId: message.historicalContext.humanParticipantId,
			modelParticipantId: message.historicalContext.modelParticipantId,
		},
		variantId: message.variant?.id ?? null,
		content: message.variant?.content ?? null,
	}));
};

const semanticRecipeSlot = (slot: PromptPresetSlot): GenerationJsonObject => {
	if (slot.reference === "history") {
		return { reference: slot.reference, enabled: slot.enabled };
	}
	if (slot.reference === "instruction") {
		return {
			reference: slot.reference,
			enabled: slot.enabled,
			role: slot.role,
			name: slot.name,
			content: slot.content,
		};
	}
	return { reference: slot.reference, enabled: slot.enabled, role: slot.role };
};

const continuationTarget = (preparation: GenerationPreparation): GenerationJsonValue => {
	if (preparation.kind !== "continuation") return null;
	const latest = preparation.participation.messages.at(-1);
	return {
		messageId: latest?.id ?? null,
		variantId: latest?.variant?.id ?? null,
		content: latest?.variant?.content ?? null,
	};
};

/** ==[HUMAN APPROVED]== Fingerprint the semantic inputs an inspected plan actually participates in. */
export const generationPreparationFingerprint = (
	preparation: GenerationPreparation,
): string => {
	const sendReuseTarget = sendReuseTargetOf(preparation);
	const input: GenerationJsonObject = {
		kind: preparation.kind,
		content: preparation.content ?? null,
		messageId: preparation.messageId ?? null,
		formatting: {
			timeZone: preparation.formatting.timeZone ?? null,
			locale: preparation.formatting.locale ?? null,
		},
		control: {
			humanParticipantId: preparation.participation.control.humanParticipantId,
			modelParticipantId: preparation.participation.control.modelParticipantId,
		},
		participants: relevantPreparationSources(preparation),
		recipe: {
			id: preparation.recipe.id,
			slots: preparation.recipe.slots.filter((slot) => slot.enabled).map(semanticRecipeSlot),
		},
		settings: effectivePreparationSettings(preparation),
		macroState: [...preparation.macroState.entries()]
			.sort(([left], [right]) => left.localeCompare(right)),
		continuationTarget: continuationTarget(preparation),
		sendReuseTarget: sendReuseTarget === undefined ? null : {
			messageId: sendReuseTarget.messageId,
			variantId: sendReuseTarget.variantId,
		},
		connection: preparation.connection === null ? null : {
			profileId: preparation.connection.profileId,
			settingsRevision: preparation.connection.settingsRevision,
			backend: preparation.connection.backend,
			adapter: preparation.connection.adapter,
			apiFormat: preparation.connection.apiFormat,
		},
		history: relevantPreparationHistory(preparation),
	};
	return JSON.stringify(canonicalize(input));
};
