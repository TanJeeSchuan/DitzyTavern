import type { GenerationPreparation } from "./generate-capture";
import type { GenerationJsonValue } from "../../shared/generation-json";

const capturedLoreEvidence = (value: GenerationJsonValue): GenerationJsonValue => {
	if (!Array.isArray(value)) return value;
	return value.map((item) => {
		if (Array.isArray(item)) return item;
		// ==[HUMAN APPROVED]== SAFETY: Lore activation evidence is an array of object records;
		// primitive entries cannot be produced by its server-owned record builder.
		return Object.fromEntries(
			Object.entries(item as Readonly<Record<string, GenerationJsonValue>>)
				.filter(([key]) => key !== "match"),
		);
	});
};

const loreFingerprintOf = (preparation: GenerationPreparation) => ({
	allowance: preparation.lore.allowance,
	scan: preparation.lore.scan,
	evidence: capturedLoreEvidence(preparation.lore.activation.evidence),
	semantic: preparation.lore.sources === undefined
		? null
		: {
				mode: preparation.lore.sources.semanticSettings.mode,
				threshold: preparation.lore.sources.semanticSettings.threshold,
				jevModel: preparation.lore.sources.semanticSettings.jevModel,
			},
});

/** ==[HUMAN APPROVED]==
 * The preparation itself is the canonical stable input for preview staleness. It contains no
 * runtime clock, random source, or connection secrets. Macro state is the only non-JSON value,
 * so this projection replaces only that Map with its stable ordered entries.
 */
export const generationPreparationFingerprint = (
	preparation: GenerationPreparation,
): string => JSON.stringify({
	...preparation,
	lore: loreFingerprintOf(preparation),
	memory: preparation.memory.fingerprintInputs,
	macroState: [...preparation.macroState.entries()]
		.sort(([left], [right]) => left.localeCompare(right)),
});
