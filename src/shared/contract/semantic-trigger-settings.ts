import { Type, type Static } from "@sinclair/typebox";
import { decisionSelection } from "./decision-model";

export const semanticTriggerSettings = Type.Composite([decisionSelection, Type.Object({ revision: Type.Integer(), triggerThreshold: Type.Number() })]);
export type SemanticTriggerSettingsPayload = Static<typeof semanticTriggerSettings>;
export const semanticTriggerSettingsApplied = Type.Object({ outcome: Type.Literal("applied"), settings: semanticTriggerSettings });
export const semanticTriggerSettingsConflict = Type.Object({ outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: semanticTriggerSettings });
export const semanticTriggerSettingsInvalid = Type.Object({ outcome: Type.Literal("invalid"), reason: Type.String() });
export const semanticTriggerSettingsCommandBody = Type.Composite([Type.Omit(semanticTriggerSettings, ["revision"]), Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer() })]);
export type SemanticTriggerSettingsCommand = Static<typeof semanticTriggerSettingsCommandBody>;
