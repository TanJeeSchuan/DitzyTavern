import { Type, type Static } from "@sinclair/typebox";
import { decisionSelection } from "./decision-model";
import { invalidOutcome, revisionConflict } from "./outcomes";

export const semanticTriggerSettings = Type.Composite([decisionSelection, Type.Object({ revision: Type.Integer(), triggerThreshold: Type.Number() })]);
export type SemanticTriggerSettingsPayload = Static<typeof semanticTriggerSettings>;
export const semanticTriggerSettingsApplied = Type.Object({ outcome: Type.Literal("applied"), settings: semanticTriggerSettings });
export const semanticTriggerSettingsConflict = revisionConflict(semanticTriggerSettings);

// @approved
//  The Semantic Trigger Settings command route's modeled error union: the
// 409/422 envelopes the command route declares, so the client decodes an
// error body against exactly that union.
export const semanticTriggerSettingsCommandErrors = Type.Union([
	semanticTriggerSettingsConflict,
	invalidOutcome,
]);
export const semanticTriggerSettingsCommandBody = Type.Composite([Type.Omit(semanticTriggerSettings, ["revision"]), Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer() })]);
export type SemanticTriggerSettingsCommand = Static<typeof semanticTriggerSettingsCommandBody>;
