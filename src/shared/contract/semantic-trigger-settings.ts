import { Type, type Static } from "@sinclair/typebox";
import { decisionSelection } from "./decision-model";
import { invalidOutcome, revisionConflict } from "./outcomes";

const semanticTriggerSettings = Type.Composite([decisionSelection, Type.Object({ revision: Type.Integer(), triggerThreshold: Type.Number() })]);
export type SemanticTriggerSettingsPayload = Static<typeof semanticTriggerSettings>;
export const semanticTriggerSettingsReadResponse = { 200: semanticTriggerSettings };
export const semanticTriggerSettingsCommandResponse = {
	200: Type.Object({ outcome: Type.Literal("applied"), settings: semanticTriggerSettings }),
	409: revisionConflict(semanticTriggerSettings),
	422: invalidOutcome,
};
export const semanticTriggerSettingsCommandBody = Type.Composite([Type.Omit(semanticTriggerSettings, ["revision"]), Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer() })]);
export type SemanticTriggerSettingsCommand = Static<typeof semanticTriggerSettingsCommandBody>;
