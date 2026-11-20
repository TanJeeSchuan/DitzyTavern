import type { MacroValue } from "../../shared/contract/macro-variable-write";
import { MACRO_DATA_NAMESPACE } from "../../shared/variant-data-codecs";
import { macroInitialValueKey } from "../prompt-macros";

export const macroInitialValuesToData = (presetId: number, values: Readonly<Record<string, MacroValue>>) =>
	Object.entries(values).map(([name, value]) => ({
		namespace: MACRO_DATA_NAMESPACE,
		key: macroInitialValueKey(presetId, name),
		value: JSON.stringify(value),
	}));
