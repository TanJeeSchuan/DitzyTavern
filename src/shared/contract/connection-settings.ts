import { Type, type Static } from "@sinclair/typebox";
import { invalidOutcome, notFoundOutcome, revisionConflict } from "./outcomes";

const redactedHeader = Type.Object({
	name: Type.String(),
	configured: Type.Boolean(),
});

const headerOperation = Type.Union([
	Type.Object({ name: Type.String(), operation: Type.Literal("keep") }),
	Type.Object({ name: Type.String(), operation: Type.Literal("replace"), value: Type.String() }),
	Type.Object({ name: Type.String(), operation: Type.Literal("remove") }),
]);

const apiFormat = Type.Union([
	Type.Literal("chat-completions"),
	Type.Literal("responses"),
	Type.Literal("anthropic-messages"),
	Type.Literal("embeddings"),
	Type.Literal("images"),
	Type.Literal("system-one"),
]);

// @approved
//  How a request lays out system blocks. Strict sends one leading run of
// system messages, the shape every chat target accepts: system blocks before
// history move to the front, and later ones are sent as user messages where
// they stand. None sends the plan exactly as authored.
const systemPlacement = Type.Union([Type.Literal("strict"), Type.Literal("none")]);

const profileDraft = Type.Object({
	displayName: Type.String(),
	apiFormat,
	requestUrl: Type.String(),
	modelsUrl: Type.String(),
	modelBackend: Type.Union([Type.Literal("automatic"), Type.Literal("ai-sdk")]),
	adapter: Type.Union([
		Type.Literal("openai-compatible"),
		Type.Literal("deepseek"),
		Type.Literal("openrouter"),
	]),
	outputTokenRepresentation: Type.Union([
		Type.Literal("automatic"),
		Type.Literal("max_tokens"),
		Type.Literal("max_completion_tokens"),
		Type.Literal("omit"),
	]),
	systemPlacement,
	timeoutMs: Type.Union([Type.Null(), Type.Integer()]),
	pinnedModels: Type.Array(Type.String()),
}, { additionalProperties: false });

export const connectionProfile = Type.Object({
	id: Type.Integer(),
	displayName: Type.String(),
	apiFormat,
	requestUrl: Type.String(),
	modelsUrl: Type.String(),
	modelBackend: Type.Union([Type.Literal("automatic"), Type.Literal("ai-sdk")]),
	adapter: Type.Union([Type.Literal("openai-compatible"), Type.Literal("deepseek"), Type.Literal("openrouter")]),
	outputTokenRepresentation: Type.Union([Type.Literal("automatic"), Type.Literal("max_tokens"), Type.Literal("max_completion_tokens"), Type.Literal("omit")]),
	systemPlacement,
	timeoutMs: Type.Union([Type.Null(), Type.Integer()]),
	pinnedModels: Type.Array(Type.String()),
	discoveryCatalog: Type.Array(Type.String()),
	textOnlyModels: Type.Array(Type.String()),
	credentialState: Type.Union([Type.Literal("none"), Type.Literal("saved"), Type.Literal("unreadable")]),
	headers: Type.Array(redactedHeader),
});

const connectionSettings = Type.Object({
	revision: Type.Integer(),
	profiles: Type.Array(connectionProfile),
});

const preset = Type.Object({
	id: Type.String(),
	label: Type.String(),
	description: Type.String(),
	profile: profileDraft,
});

export const connectionCommandBody = Type.Union([
	Type.Object({
		type: Type.Literal("create-profile"),
		expectedRevision: Type.Integer(),
		profile: profileDraft,
		credential: Type.Optional(Type.Union([Type.Null(), Type.String()])),
		headers: Type.Optional(Type.Array(headerOperation)),
	}),
	Type.Object({
		type: Type.Literal("apply-profile"),
		expectedRevision: Type.Integer(),
		profileId: Type.Integer(),
		profile: profileDraft,
		credential: Type.Optional(Type.String()),
		headers: Type.Optional(Type.Array(headerOperation)),
	}),
	Type.Object({
		type: Type.Literal("set-credential"),
		expectedRevision: Type.Integer(),
		profileId: Type.Integer(),
		credential: Type.String(),
	}),
	Type.Object({
		type: Type.Literal("reset-credential"),
		expectedRevision: Type.Integer(),
		profileId: Type.Integer(),
		confirmed: Type.Boolean(),
	}),
	Type.Object({
		type: Type.Literal("delete-profile"),
		expectedRevision: Type.Integer(),
		profileId: Type.Integer(),
	}),
	Type.Object({
		type: Type.Literal("set-pinned-models"),
		expectedRevision: Type.Integer(),
		profileId: Type.Integer(),
		pinnedModels: Type.Array(Type.String()),
	}),
]);

export const connectionTestBody = Type.Object({
	profileId: Type.Optional(Type.Integer()),
	profile: profileDraft,
	modelId: Type.String(),
	headers: Type.Optional(Type.Array(headerOperation)),
});

const connectionTestResult = Type.Union([
	Type.Object({
		outcome: Type.Literal("success"),
		message: Type.String(),
	}),
	Type.Object({
		outcome: Type.Literal("failure"),
		kind: Type.Union([
			Type.Literal("authentication"),
			Type.Literal("endpoint"),
			Type.Literal("timeout"),
			Type.Literal("redirect"),
			Type.Literal("malformed-response"),
			Type.Literal("adapter-unavailable"),
		]),
		message: Type.String(),
		responseBody: Type.Optional(Type.String()),
	}),
]);

const discoveryFailureKind = Type.Union([
	Type.Literal("authentication"),
	Type.Literal("endpoint"),
	Type.Literal("timeout"),
	Type.Literal("redirect"),
	Type.Literal("malformed-response"),
]);

const connectionSettingsConflict = revisionConflict(connectionSettings);

const connectionDiscoveryResult = Type.Union([
	Type.Object({
		outcome: Type.Literal("success"),
		profile: connectionProfile,
		settingsRevision: Type.Integer(),
	}),
	Type.Object({
		outcome: Type.Literal("failure"),
		kind: discoveryFailureKind,
		message: Type.String(),
	}),
	connectionSettingsConflict,
]);

// Route boundary schemas referenced by the Connection Settings adapter.

export const connectionDiscoveryBody = Type.Object({ profileId: Type.Integer() });

export const connectionTextOnlyBody = Type.Object({
	profileId: Type.Integer(),
	modelId: Type.String(),
	textOnly: Type.Boolean(),
});

// The unconfigured Connection Profile is shared by the client editor and the
// OpenAI Compatible preset. Keeping this literal beside the schema
// makes the blank state a contract-owned default rather than a layer-specific
// copy.
export const blankConnectionProfileDraft = {
	displayName: "",
	apiFormat: "chat-completions",
	requestUrl: "",
	modelsUrl: "",
	modelBackend: "automatic",
	adapter: "openai-compatible",
	outputTokenRepresentation: "automatic",
	systemPlacement: "strict",
	timeoutMs: 120000,
	pinnedModels: [],
} satisfies Static<typeof profileDraft>;

const connectionSettingsApplied = Type.Object({
	outcome: Type.Literal("applied"),
	settings: connectionSettings,
});

export const connectionSettingsResponse = { 200: connectionSettings };
export const connectionPresetsResponse = { 200: Type.Object({ presets: Type.Array(preset) }) };
export const connectionCommandResponse = { 200: connectionSettingsApplied, 404: notFoundOutcome, 409: connectionSettingsConflict, 422: invalidOutcome };
export const connectionDiscoveryResponse = { ...connectionCommandResponse, 200: connectionDiscoveryResult };
export const connectionTestResponse = { 200: connectionTestResult, 422: invalidOutcome };
export const connectionTextOnlyResponse = { 200: connectionSettingsApplied, 404: notFoundOutcome, 422: invalidOutcome };

export type ConnectionProfileDraftPayload = Static<typeof profileDraft>;
export type ConnectionProfilePayload = Static<typeof connectionProfile>;
export type ConnectionSettingsPayload = Static<typeof connectionSettings>;
export type ConnectionPresetPayload = Static<typeof preset>;
export type ConnectionHeaderOperationPayload = Static<typeof headerOperation>;

export type ConnectionSettingsCommandPayload = Static<typeof connectionCommandBody>;

export type ConnectionTestDraftPayload = {
	profileId?: number;
	profile: ConnectionProfileDraftPayload;
	modelId: string;
	headers?: ConnectionHeaderOperationPayload[];
};

/**
 * Projects either a complete Profile payload or a draft into the command
 * shape. This is the one wire projection for the editable Profile fields;
 * callers receive a fresh pinned-model list so drafts remain independently
 * editable.
 */
export function connectionProfileDraftOf(
	profile: ConnectionProfilePayload | ConnectionProfileDraftPayload,
): ConnectionProfileDraftPayload {
	return {
		displayName: profile.displayName,
		apiFormat: profile.apiFormat,
		requestUrl: profile.requestUrl,
		modelsUrl: profile.modelsUrl,
		modelBackend: profile.modelBackend,
		adapter: profile.adapter,
		outputTokenRepresentation: profile.outputTokenRepresentation,
		systemPlacement: profile.systemPlacement,
		timeoutMs: profile.timeoutMs,
		pinnedModels: [...profile.pinnedModels],
	};
}
