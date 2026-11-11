import { Type, type Static } from "@sinclair/typebox";
import { invalidOutcome, notFoundOutcome } from "./outcomes";

export const imageModelSelection = Type.Object({ profileId: Type.Union([Type.Integer(), Type.Null()]), model: Type.String() });
export const imageModelSettings = Type.Composite([imageModelSelection, Type.Object({ revision: Type.Integer() })]);
export const imageModelCommand = Type.Composite([imageModelSelection, Type.Object({ type: Type.Literal("apply"), expectedRevision: Type.Integer() })]);
export const imageModelApplied = Type.Object({ outcome: Type.Literal("applied"), settings: imageModelSettings });
export const imageModelConflict = Type.Object({ outcome: Type.Literal("conflict"), expectedRevision: Type.Integer(), actualRevision: Type.Integer(), currentSettings: imageModelSettings });
export const imageModelErrors = Type.Union([imageModelConflict, invalidOutcome, notFoundOutcome]);
export type ImageModelSelection = Static<typeof imageModelSelection>;
export type ImageModelSettings = Static<typeof imageModelSettings>;
export type ImageModelCommand = Static<typeof imageModelCommand>;
