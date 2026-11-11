import { Type, type Static } from "@sinclair/typebox";
import type { ConnectionProfilePayload } from "./connection-settings";
import { invalidOutcome } from "./outcomes";

export const modelSelection = Type.Object({ profileId: Type.Union([Type.Integer(), Type.Null()]), model: Type.String() });
export const modelSelectionSettings = Type.Composite([modelSelection, Type.Object({ revision: Type.Integer() })]);
export const modelSelectionCommand = Type.Composite([modelSelection, Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer() })]);
export const modelSelectionApplied = Type.Object({ outcome: Type.Literal("applied"), settings: modelSelectionSettings });
export const modelSelectionConflict = Type.Object({ outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: modelSelectionSettings });
export const modelSelectionErrors = Type.Union([modelSelectionConflict, invalidOutcome]);
export type ModelSelection = Static<typeof modelSelection>;
export type ModelSelectionSettings = Static<typeof modelSelectionSettings>;
export type ModelSelectionCommand = Static<typeof modelSelectionCommand>;

export const modelSelectionConnectionLabels = { images: "Images", "chat-completions": "Chat Completions" } satisfies Partial<Record<ConnectionProfilePayload["apiFormat"], string>>;
export type ModelSelectionApiFormat = keyof typeof modelSelectionConnectionLabels;
