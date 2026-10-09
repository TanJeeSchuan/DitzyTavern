import { Type, type Static } from "@sinclair/typebox";
import { decisionSelection } from "./decision-model";
import { invalidOutcome } from "./outcomes";

export const memorySettings = Type.Composite([decisionSelection, Type.Object({
	revision: Type.Integer(),
	enabled: Type.Boolean(),
	extractionProfileId: Type.Union([Type.Integer(), Type.Null()]),
	extractionModel: Type.String(),
	contextLimit: Type.Integer(),
	outputReserve: Type.Integer(),
	safetyAllowance: Type.Integer(),
	retainProbabilityMinimum: Type.Number(),
	recallRelevanceMinimum: Type.Number(),
	embeddingProfileId: Type.Union([Type.Integer(), Type.Null()]),
	embeddingModel: Type.String(),
})]);
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
export const memorySettingsCommandBody = Type.Composite([Type.Object({ expectedRevision: Type.Integer() }), Type.Omit(memorySettings, ["revision"])]);
export type MemorySettingsCommand = Static<typeof memorySettingsCommandBody>;
