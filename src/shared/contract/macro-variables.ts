import { Type, type Static } from "@sinclair/typebox";
import { conversationSummary } from "./conversation-schema";
import { numericWire } from "./wire";
// Macro values and writes are shared by the evaluator, persistence seam, and
// transport contract. Keeping their vocabulary here prevents those layers
// from each declaring a subtly different record shape.
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

export const macroVariableWrite = Type.Union([
	Type.Object({
		operation: Type.Literal("set"),
		name: Type.String(),
		value: macroValue,
	}),
	Type.Object({
		operation: Type.Literal("delete"),
		name: Type.String(),
		value: Type.Optional(Type.Undefined()),
	}),
]);

const macroVariableSource = Type.Union([
	Type.Object({ type: Type.Literal("initial") }),
	Type.Object({
		type: Type.Literal("variant"),
		messageId: Type.Integer(),
		messagePosition: Type.Integer(),
		variantId: Type.Integer(),
		variantPosition: Type.Integer(),
	}),
]);

export const macroVariable = Type.Object({
	name: Type.String(),
	value: macroValue,
	source: macroVariableSource,
});

export const macroVariablesTarget = Type.Union([
	Type.Object({ type: Type.Literal("initial") }),
	Type.Object({
		type: Type.Literal("variant"),
		messageId: Type.Integer(),
		messagePosition: Type.Integer(),
		variantId: Type.Integer(),
		variantPosition: Type.Integer(),
	}),
]);

export const macroVariables = Type.Object({
	conversationId: Type.Integer(),
	promptPresetId: Type.Integer(),
	promptPresetName: Type.String(),
	position: Type.Integer(),
	target: macroVariablesTarget,
	variables: Type.Array(macroVariable),
});

export const macroVariablesQuery = Type.Object({
	position: Type.Optional(numericWire),
	promptPresetId: Type.Optional(numericWire),
});

const macroVariableSet = Type.Object({
	operation: Type.Literal("set"),
	name: Type.String(),
	value: macroValue,
});

const macroVariableDelete = Type.Object({
	operation: Type.Literal("delete"),
	name: Type.String(),
});

export const macroVariablesEditBody = Type.Union([
	Type.Object({
		expectedRevision: Type.Integer(),
		promptPresetId: Type.Integer(),
		position: Type.Integer({ minimum: 0 }),
		...macroVariableSet.properties,
	}),
	Type.Object({
		expectedRevision: Type.Integer(),
		promptPresetId: Type.Integer(),
		position: Type.Integer({ minimum: 0 }),
		...macroVariableDelete.properties,
	}),
]);

export const macroVariablesAppliedResponse = Type.Object({
	outcome: Type.Literal("applied"),
	conversation: conversationSummary,
	variables: macroVariables,
});

export type MacroVariableSource = Static<typeof macroVariableSource>;
export type MacroVariableWrite = Static<typeof macroVariableWrite>;
export type MacroVariable = Static<typeof macroVariable>;
export type MacroVariablesTarget = Static<typeof macroVariablesTarget>;
export type MacroVariables = Static<typeof macroVariables>;
export type MacroVariablesQuery = Static<typeof macroVariablesQuery>;
export type MacroVariablesEditBody = Static<typeof macroVariablesEditBody>;
export type MacroVariablesAppliedResponse = Static<typeof macroVariablesAppliedResponse>;
