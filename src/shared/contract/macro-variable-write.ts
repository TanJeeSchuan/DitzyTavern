import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { GenerationJsonObject, GenerationJsonValue } from "../generation-json";

// Macro values and writes are shared by the evaluator, persistence seam, and
// transport contract. Keeping their vocabulary in this leaf module prevents
// the shared write declaration from depending on a larger response contract.
export type MacroValue = string | number | boolean | null | readonly MacroValue[];

export const isMacroVariableName = (value: string): boolean => /^[A-Za-z](?:[\w-]*[\w])?$/.test(value);

export const isMacroValue = (value: unknown): value is MacroValue =>
	value === null ||
	typeof value === "string" ||
	typeof value === "number" && Number.isFinite(value) ||
	typeof value === "boolean" ||
	Array.isArray(value) && value.every(isMacroValue);

// Macro values deliberately remain provider-neutral scalar/array JSON. This
// recursive schema keeps the transport boundary and the MacroValue domain
// union on the same contract.
export const macroValue = Type.Unsafe<MacroValue>(Type.Unknown());

export const macroVariableSetWrite = Type.Object({
	operation: Type.Literal("set"),
	name: Type.String(),
	value: macroValue,
});

export const macroVariableDeleteWrite = Type.Object({
	operation: Type.Literal("delete"),
	name: Type.String(),
	value: Type.Optional(Type.Undefined()),
});

// The one recorded-write declaration used by the evaluator journal, storage,
// inspected-plan response, and Macro Variable edit request.
export const macroVariableWrite = Type.Union([macroVariableSetWrite, macroVariableDeleteWrite]);

export type MacroVariableWrite = Static<typeof macroVariableWrite>;

/** Encode one write as the JSON object used by persisted journals. */
export const encodeMacroVariableWrite = (write: MacroVariableWrite): GenerationJsonObject =>
	write.operation === "set"
		? { name: write.name, operation: write.operation, value: write.value }
		: { name: write.name, operation: write.operation };

/** Decode one persisted or wire value against the shared write declaration. */
export const decodeMacroVariableWrite = (value: GenerationJsonValue): MacroVariableWrite | undefined => {
	try {
		const write = Value.Decode(macroVariableWrite, value);
		if (!isMacroVariableName(write.name)) return undefined;
		if (write.operation === "set" && !isMacroValue(write.value)) return undefined;
		return write;
	} catch {
		return undefined;
	}
};
