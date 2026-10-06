import { Type, type Static } from "@sinclair/typebox";

const probabilities = Type.Record(Type.String(), Type.Number({ minimum: 0, maximum: 1 }));
export const decisionAnswer = Type.Union([
	Type.Object({ type: Type.Literal("choice"), choice: Type.String(), probabilities, confidence: Type.Optional(Type.Number()) }),
	Type.Object({ type: Type.Literal("score"), score: Type.Number(), probabilities, confidence: Type.Optional(Type.Number()), legend: Type.Optional(Type.Record(Type.String(), Type.String())) }),
	Type.Object({ type: Type.Literal("noul"), noul: Type.Number({ minimum: 0, maximum: 1 }) }),
]);
export type DecisionAnswer = Static<typeof decisionAnswer>;
export const decisionResponse = Type.Object({ answers: Type.Record(Type.String(), decisionAnswer) });

export const decisionSelection = Type.Object({
	decisionProfileId: Type.Union([Type.Integer(), Type.Null()]),
	decisionModel: Type.String(),
	decisionStateTokenLimit: Type.Integer(),
});
export type DecisionSelection = Static<typeof decisionSelection>;
