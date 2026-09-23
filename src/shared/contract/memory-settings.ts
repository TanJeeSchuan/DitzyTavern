import { Type, type Static } from "@sinclair/typebox";

export const memorySettings = Type.Object({
	revision: Type.Integer(),
	extractionProfileId: Type.Union([Type.Integer(), Type.Null()]),
	extractionModel: Type.String(),
	contextLimit: Type.Integer(),
	outputReserve: Type.Integer(),
	safetyAllowance: Type.Integer(),
	jevModel: Type.String(),
	credentialConfigured: Type.Boolean(),
});
export type MemorySettingsPayload = Static<typeof memorySettings>;

export const memorySettingsResponse = memorySettings;
export const memorySettingsApplied = Type.Object({ outcome: Type.Literal("applied"), settings: memorySettings });
export const memorySettingsConflict = Type.Object({
	outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: memorySettings,
});
export const memorySettingsInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });
export const memorySettingsCommandBody = Type.Union([
	Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer(), extractionProfileId: Type.Union([Type.Integer(), Type.Null()]), extractionModel: Type.String(), contextLimit: Type.Integer(), outputReserve: Type.Integer(), safetyAllowance: Type.Integer(), jevModel: Type.String(), credential: Type.Optional(Type.String()) }),
	Type.Object({ type: Type.Literal("set-credential"), expectedRevision: Type.Integer(), credential: Type.String() }),
	Type.Object({ type: Type.Literal("reset-credential"), expectedRevision: Type.Integer(), confirmed: Type.Boolean() }),
]);
export type MemorySettingsCommand = Static<typeof memorySettingsCommandBody>;
