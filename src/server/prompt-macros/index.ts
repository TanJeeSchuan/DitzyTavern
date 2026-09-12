export {
	MACRO_DATA_NAMESPACE,
	deriveMacroState,
	deriveMacroVariables,
	isMacroDataNamespace,
	macroInitialValuesToData,
	macroWritesToData,
	nextMacroWriteSequence,
	parseMacroWrites,
	readMacroInitialValues,
	readMacroWrites,
} from "./state";
export { isMacroValue, isMacroVariableName } from "../../shared/contract/macro-variables";
export type { DerivedMacroVariable, MacroVariableSource } from "./state";
