import { Type, type Static } from "@sinclair/typebox";

export const memorySettings = Type.Object({
	revision: Type.Integer(),
	enabled: Type.Boolean(),
	extractionProfileId: Type.Union([Type.Integer(), Type.Null()]),
	extractionModel: Type.String(),
	contextLimit: Type.Integer(),
	outputReserve: Type.Integer(),
	safetyAllowance: Type.Integer(),
	usefulnessConfidenceGate: Type.Number(),
	recallRelevanceMinimum: Type.Number(),
});
export type MemorySettingsPayload = Static<typeof memorySettings>;

export const memorySettingsResponse = memorySettings;
export const memorySettingsApplied = Type.Object({ outcome: Type.Literal("applied"), settings: memorySettings });
export const memorySettingsConflict = Type.Object({
	outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: memorySettings,
});
export const memorySettingsInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });
export const memorySettingsCommandBody = Type.Object({ expectedRevision: Type.Integer(), enabled: Type.Boolean(), extractionProfileId: Type.Union([Type.Integer(), Type.Null()]), extractionModel: Type.String(), contextLimit: Type.Integer(), outputReserve: Type.Integer(), safetyAllowance: Type.Integer(), usefulnessConfidenceGate: Type.Number(), recallRelevanceMinimum: Type.Number() });
export type MemorySettingsCommand = Static<typeof memorySettingsCommandBody>;
