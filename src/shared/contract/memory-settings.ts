import { Type, type Static } from "@sinclair/typebox";
import { invalidOutcome } from "./outcomes";

// @approved
//  The stored Memory Settings value, kept in library_data under `box:memory`.
// Memory's Decision Model is the host's selection for the Box.
export const memorySettingsValue = Type.Object({
	extractionProfileId: Type.Union([Type.Integer(), Type.Null()]),
	extractionModel: Type.String(),
	contextLimit: Type.Integer(),
	outputReserve: Type.Integer(),
	safetyAllowance: Type.Integer(),
	retainProbabilityMinimum: Type.Number(),
	recallRelevanceMinimum: Type.Number(),
	embeddingProfileId: Type.Union([Type.Integer(), Type.Null()]),
	embeddingModel: Type.String(),
});
export type MemorySettingsValue = Static<typeof memorySettingsValue>;
export const memorySettings = Type.Composite([memorySettingsValue, Type.Object({ revision: Type.Integer() })]);
export type MemorySettingsPayload = Static<typeof memorySettings>;

export const memorySettingsResponse = memorySettings;
export const memorySettingsApplied = Type.Object({ outcome: Type.Literal("applied"), settings: memorySettings });
export const memorySettingsConflict = Type.Object({
	outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: memorySettings,
});

// @approved
//  The Memory Settings command route's modeled error union: the composed
// 409/422 envelopes the command route declares, so the client decodes an
// error body against exactly that union.
export const memorySettingsCommandErrors = Type.Union([memorySettingsConflict, invalidOutcome]);
export const memorySettingsCommandBody = Type.Composite([Type.Object({ expectedRevision: Type.Integer() }), memorySettingsValue]);
export type MemorySettingsCommand = Static<typeof memorySettingsCommandBody>;
