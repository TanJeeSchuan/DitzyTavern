import { Type, type Static } from "@sinclair/typebox";

export const embeddingSettings = Type.Object({
	revision: Type.Integer(),
	endpoint: Type.String(),
	model: Type.String(),
	deadlineMs: Type.Integer({ minimum: 1 }),
	credentialConfigured: Type.Boolean(),
});

export const embeddingSettingsResponse = embeddingSettings;

export const embeddingSettingsApplied = Type.Object({
	outcome: Type.Literal("applied"),
	settings: embeddingSettings,
});

export const embeddingSettingsConflict = Type.Object({
	outcome: Type.Literal("conflict"),
	expectedRevision: Type.Integer(),
	actualRevision: Type.Integer(),
	currentSettings: embeddingSettings,
});

export const embeddingSettingsInvalid = Type.Object({
	outcome: Type.Literal("invalid"),
	reason: Type.String(),
});

export const embeddingSettingsCommandBody = Type.Union([
	Type.Object({
		type: Type.Literal("apply"),
		expectedRevision: Type.Integer(),
		endpoint: Type.String(),
		model: Type.String(),
		deadlineMs: Type.Integer(),
		credential: Type.Optional(Type.Union([Type.Null(), Type.String()])),
	}),
	Type.Object({
		type: Type.Literal("set-credential"),
		expectedRevision: Type.Integer(),
		credential: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("reset-credential"),
		expectedRevision: Type.Integer(),
		confirmed: Type.Boolean(),
	}),
]);

export type EmbeddingSettingsPayload = Static<typeof embeddingSettings>;
export type EmbeddingSettingsCommand = Static<typeof embeddingSettingsCommandBody>;

