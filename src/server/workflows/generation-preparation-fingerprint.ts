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
): string => JSON.stringify({
	...snapshot,
	lore: loreFingerprintOf(snapshot),
	memory: snapshot.memory.freshnessFingerprint,
	macroState: [...snapshot.macroState.entries()]
		.sort(([left], [right]) => left.localeCompare(right)),
});
