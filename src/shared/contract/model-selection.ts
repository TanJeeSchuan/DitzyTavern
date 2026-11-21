import { Type, type Static } from "@sinclair/typebox";
import type { ConnectionProfilePayload } from "./connection-settings";
import { invalidOutcome, revisionConflict } from "./outcomes";

export const modelSelection = Type.Object({ profileId: Type.Union([Type.Integer(), Type.Null()]), model: Type.String() });
const modelSelectionSettings = Type.Composite([modelSelection, Type.Object({ revision: Type.Integer() })]);
export const modelSelectionCommand = Type.Composite([modelSelection, Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer() })]);
export const modelSelectionReadResponse = { 200: modelSelectionSettings };
export const modelSelectionCommandResponse = {
	200: Type.Object({ outcome: Type.Literal("applied"), settings: modelSelectionSettings }),
	409: revisionConflict(modelSelectionSettings),
	422: invalidOutcome,
};
export type ModelSelection = Static<typeof modelSelection>;
export type ModelSelectionSettings = Static<typeof modelSelectionSettings>;
export type ModelSelectionCommand = Static<typeof modelSelectionCommand>;

export const modelSelectionConnectionLabels = { images: "Images", "chat-completions": "Chat Completions" } satisfies Partial<Record<ConnectionProfilePayload["apiFormat"], string>>;
export type ModelSelectionApiFormat = keyof typeof modelSelectionConnectionLabels;
