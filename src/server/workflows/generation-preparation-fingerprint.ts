import type { GenerationPreparation } from "./generate-capture";

/** ==[HUMAN APPROVED]==
 * The preparation itself is the canonical stable input for preview staleness. It contains no
 * runtime clock, random source, or connection secrets. Macro state is the only non-JSON value,
 * so this projection replaces only that Map with its stable ordered entries.
 */
export const generationPreparationFingerprint = (
	preparation: GenerationPreparation,
): string => JSON.stringify({
	...preparation,
	macroState: [...preparation.macroState.entries()]
		.sort(([left], [right]) => left.localeCompare(right)),
});
