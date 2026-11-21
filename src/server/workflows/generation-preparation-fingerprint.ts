import { fingerprintBoxes } from "../box/registry";
import type { PreparationSnapshot } from "./generate-capture";

const loreFingerprintOf = (snapshot: PreparationSnapshot) => ({
	allowance: snapshot.lore.allowance,
	scan: snapshot.lore.scan,
	evidence: snapshot.lore.activation.evidence,
	semantic: snapshot.lore.sources === undefined
		? null
		: {
				decisionProfileId: snapshot.lore.sources.semanticSettings.decisionProfileId,
				threshold: snapshot.lore.sources.semanticSettings.triggerThreshold,
				decisionModel: snapshot.lore.sources.semanticSettings.decisionModel,
				decisionStateTokenLimit: snapshot.lore.sources.semanticSettings.decisionStateTokenLimit,
			},
});

export const generationPreparationFingerprint = (
	snapshot: PreparationSnapshot,
): string => {
	const fields = {
		conversationId: snapshot.conversationId,
		target: snapshot.target,
		seed: snapshot.seed,
		settings: snapshot.settings,
		connection: snapshot.connection,
		recipe: snapshot.recipe,
		formatting: snapshot.formatting,
		derivation: snapshot.derivation,
		pendingHumanText: snapshot.pendingHumanText,
		semanticTriggerRevision: snapshot.semanticTriggerRevision,
		boxWarnings: snapshot.boxWarnings,
		lore: loreFingerprintOf(snapshot),
		boxes: fingerprintBoxes(snapshot.boxes),
		boxImages: [...snapshot.boxImages].sort(([left], [right]) => left.localeCompare(right))
			.map(([reference, { label, hashes }]) => [reference, { label, hashes: [...hashes].sort() }]),
		macroState: [...snapshot.macroState.entries()]
			.sort(([left], [right]) => left.localeCompare(right)),
	};
	return JSON.stringify(fields satisfies Record<keyof PreparationSnapshot, typeof fields[keyof typeof fields]>);
};
