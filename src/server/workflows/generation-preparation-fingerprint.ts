import type { GenerationPreparationSnapshot } from "./generate-capture";

const loreFingerprintOf = (snapshot: GenerationPreparationSnapshot) => ({
	allowance: snapshot.lore.allowance,
	scan: snapshot.lore.scan,
	evidence: snapshot.lore.activation.evidence,
	semantic: snapshot.lore.sources === undefined
		? null
		: {
				mode: snapshot.lore.sources.semanticSettings.mode,
				threshold: snapshot.lore.sources.semanticSettings.threshold,
				jevModel: snapshot.lore.sources.semanticSettings.jevModel,
			},
});

export const generationPreparationFingerprint = (
	snapshot: GenerationPreparationSnapshot,
): string => JSON.stringify({
	...snapshot,
	lore: loreFingerprintOf(snapshot),
	memory: snapshot.memory.activation,
	macroState: [...snapshot.macroState.entries()]
		.sort(([left], [right]) => left.localeCompare(right)),
});
