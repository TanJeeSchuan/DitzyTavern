export {
	MACRO_DATA_NAMESPACE,
	deriveMacroState,
	deriveMacroVariables,
	isMacroValue,
	isMacroVariableName,
	isMacroDataNamespace,
	macroInitialValuesToData,
	macroWritesToData,
	nextMacroWriteSequence,
	parseMacroWrites,
	readMacroInitialValues,
	readMacroWrites,
} from "./state";
export type { DerivedMacroVariable, MacroVariableSource } from "./state";
