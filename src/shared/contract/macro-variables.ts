import { Type, type Static } from "@sinclair/typebox";
import { conversationConflict, conversationSummary } from "./conversation-schema";
import { invalidOutcome, notFoundOutcome } from "./outcomes";
import { numericWire } from "./wire";
import {
	macroValue,
	macroVariableName,
	macroVariableDeleteWrite,
	macroVariableSetWrite,
} from "./macro-variable-write";
export {
	isMacroValue,
	isMacroVariableName,
	macroValue,
	macroVariableName,
	macroVariableWrite,
} from "./macro-variable-write";
export type { MacroValue, MacroVariableWrite } from "./macro-variable-write";

const macroVariableLocation = Type.Union([
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
	name: macroVariableName,
	value: macroValue,
	source: macroVariableLocation,
});

export const macroVariables = Type.Object({
	conversationId: Type.Integer(),
	promptPresetId: Type.Integer(),
	promptPresetName: Type.String(),
	position: Type.Integer(),
	target: macroVariableLocation,
	variables: Type.Array(macroVariable),
});

export const macroVariablesQuery = Type.Object({
	position: Type.Optional(numericWire),
	promptPresetId: Type.Optional(numericWire),
});

const macroVariableEditFields = Type.Object({
	expectedRevision: Type.Integer(),
	promptPresetId: Type.Integer(),
	position: Type.Integer({ minimum: 0 }),
});

export const macroVariablesEditBody = Type.Union([
	Type.Intersect([macroVariableEditFields, macroVariableSetWrite]),
	Type.Intersect([macroVariableEditFields, macroVariableDeleteWrite]),
]);

export const macroVariablesAppliedResponse = Type.Object({
	outcome: Type.Literal("applied"),
	conversation: conversationSummary,
	variables: macroVariables,
});

export type MacroVariableSource = Static<typeof macroVariableLocation>;
export type MacroVariable = Static<typeof macroVariable>;
export type MacroVariables = Static<typeof macroVariables>;
export type MacroVariablesEditBody = Static<typeof macroVariablesEditBody>;

export const macroVariablesReadResponse = {
	200: macroVariables,
	404: notFoundOutcome,
	422: invalidOutcome,
};

export const macroVariablesEditResponse = {
	200: macroVariablesAppliedResponse,
	404: notFoundOutcome,
	409: conversationConflict,
	422: invalidOutcome,
};
