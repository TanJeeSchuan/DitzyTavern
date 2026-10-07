import { Type, type Static } from "@sinclair/typebox";

export const buildIdentity = Type.Union([
	Type.Object({ distribution: Type.Literal("custom"), buildNumber: Type.Null(), revision: Type.Null() }),
	Type.Object({ distribution: Type.Literal("official"), buildNumber: Type.Integer({ minimum: 1 }), revision: Type.String({ pattern: "^[a-f0-9]{40}$" }) }),
]);
export type BuildMetadata = Static<typeof buildIdentity>;

export const updateStatus = Type.Object({
	build: buildIdentity,
	result: Type.Union([Type.Null(), Type.Object({
		comparison: Type.Union([Type.Literal("current"), Type.Literal("update_available"), Type.Literal("ahead")]),
		buildNumber: Type.Integer({ minimum: 1 }), revision: Type.String(), checkedAt: Type.String(),
	})]),
	attempt: Type.Union([Type.Null(), Type.Object({
		status: Type.Union([Type.Literal("checking"), Type.Literal("succeeded"), Type.Literal("failed")]),
		startedAt: Type.String(), error: Type.Union([Type.String(), Type.Null()]),
	})]),
});
export type UpdateStatus = Static<typeof updateStatus>;
