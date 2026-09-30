import { Type, type Static } from "@sinclair/typebox";

export const loreTriggerMode = Type.Union([Type.Literal("jev"), Type.Literal("off")]);

export const typesafeSettings = Type.Object({
	revision: Type.Integer(),
	jevModel: Type.String(),
	loreTriggerMode,
	loreTriggerThreshold: Type.Number(),
	credentialConfigured: Type.Boolean(),
});
export type TypesafeSettingsPayload = Static<typeof typesafeSettings>;

export const typesafeSettingsApplied = Type.Object({ outcome: Type.Literal("applied"), settings: typesafeSettings });
export const typesafeSettingsConflict = Type.Object({
	outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: typesafeSettings,
});
export const typesafeSettingsInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });
export const typesafeSettingsCommandBody = Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer(), jevModel: Type.String(), loreTriggerMode, loreTriggerThreshold: Type.Number(), credential: Type.Optional(Type.String()) });
export type TypesafeSettingsCommand = Static<typeof typesafeSettingsCommandBody>;

export const jevAnswer = Type.Union([
	Type.Object({ type: Type.Literal("choice"), choice: Type.String(), probabilities: Type.Record(Type.String(), Type.Number()), confidence: Type.Number() }, { additionalProperties: false }),
	Type.Object({ type: Type.Literal("score"), score: Type.Number(), legend: Type.Record(Type.String(), Type.String()), probabilities: Type.Record(Type.String(), Type.Number()), confidence: Type.Number() }, { additionalProperties: false }),
	Type.Object({ type: Type.Literal("noul"), noul: Type.Number() }, { additionalProperties: false }),
]);
export type JevAnswer = Static<typeof jevAnswer>;
export const jevResponse = Type.Object({ answers: Type.Record(Type.String(), jevAnswer) });
