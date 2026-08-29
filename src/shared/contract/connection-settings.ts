import { Type, type Static } from "@sinclair/typebox";
import { invalidOutcome, notFoundOutcome } from "./outcomes";

const redactedHeader = Type.Object({
	name: Type.String(),
	configured: Type.Boolean(),
});

const headerOperation = Type.Union([
	Type.Object({ name: Type.String(), operation: Type.Literal("keep") }),
	Type.Object({ name: Type.String(), operation: Type.Literal("replace"), value: Type.String() }),
	Type.Object({ name: Type.String(), operation: Type.Literal("remove") }),
]);

const backendOptionValue = Type.Union([
	Type.String(),
	Type.Number(),
	Type.Boolean(),
	Type.Null(),
]);

const profileDraft = Type.Object({
	displayName: Type.String(),
	apiFormat: Type.Union([
		 Type.Literal("chat-completions"),
		 Type.Literal("responses"),
		 Type.Literal("anthropic-messages"),
	]),
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
	timeoutMs: Type.Union([Type.Null(), Type.Integer()]),
	pinnedModels: Type.Array(Type.String()),
	// Legacy request payloads may still carry this field so the domain can reject
	// non-empty values explicitly; it is omitted from every exported client type.
	backendOptions: Type.Optional(Type.Record(Type.String(), backendOptionValue)),
}, { additionalProperties: false });

const profile = Type.Object({
	id: Type.Integer(),
	displayName: Type.String(),
	apiFormat: Type.Union([
		Type.Literal("chat-completions"),
		Type.Literal("responses"),
		Type.Literal("anthropic-messages"),
	]),
	requestUrl: Type.String(),
	modelsUrl: Type.String(),
	modelBackend: Type.Union([Type.Literal("automatic"), Type.Literal("ai-sdk")]),
	adapter: Type.Union([Type.Literal("openai-compatible"), Type.Literal("deepseek"), Type.Literal("openrouter")]),
	outputTokenRepresentation: Type.Union([Type.Literal("automatic"), Type.Literal("max_tokens"), Type.Literal("max_completion_tokens"), Type.Literal("omit")]),
	timeoutMs: Type.Union([Type.Null(), Type.Integer()]),
	pinnedModels: Type.Array(Type.String()),
	discoveryCatalog: Type.Array(Type.String()),
	credentialConfigured: Type.Boolean(),
	headers: Type.Array(redactedHeader),
});

const settings = Type.Object({
	revision: Type.Integer(),
	activeProfileId: Type.Union([Type.Null(), Type.Integer()]),
	profiles: Type.Array(profile),
});

const preset = Type.Object({
	id: Type.String(),
	label: Type.String(),
	description: Type.String(),
	profile: profileDraft,
});

const commandBody = Type.Union([
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
		type: Type.Literal("activate-profile"),
		expectedRevision: Type.Integer(),
		profileId: Type.Integer(),
	}),
	Type.Object({
		type: Type.Literal("delete-profile"),
		expectedRevision: Type.Integer(),
		profileId: Type.Integer(),
		replacementProfileId: Type.Optional(Type.Union([Type.Null(), Type.Integer()])),
	}),
	Type.Object({
		type: Type.Literal("set-pinned-models"),
		expectedRevision: Type.Integer(),
		profileId: Type.Integer(),
		pinnedModels: Type.Array(Type.String()),
	}),
]);

const testConnectionBody = Type.Object({
	profileId: Type.Optional(Type.Integer()),
	profile: profileDraft,
	modelId: Type.String(),
	headers: Type.Optional(Type.Array(headerOperation)),
});

const testConnectionResult = Type.Union([
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
	}),
]);

const discoveryFailureKind = Type.Union([
	Type.Literal("authentication"),
	Type.Literal("endpoint"),
	Type.Literal("timeout"),
	Type.Literal("redirect"),
	Type.Literal("malformed-response"),
]);

const discoveryResult = Type.Union([
	Type.Object({
		outcome: Type.Literal("success"),
		profile,
		settingsRevision: Type.Integer(),
	}),
	Type.Object({
		outcome: Type.Literal("failure"),
		kind: discoveryFailureKind,
		message: Type.String(),
	}),
	Type.Object({
		outcome: Type.Literal("conflict"),
		expectedRevision: Type.Integer(),
		actualRevision: Type.Integer(),
		currentSettings: settings,
	}),
]);

export { profileDraft as connectionProfileDraftSchema };

// Route boundary schemas referenced by the Connection Settings adapter.

export const connectionSettingsResponse = settings;

export const connectionPresetsResponse = Type.Object({
	presets: Type.Array(preset),
});

export const connectionDiscoveryBody = Type.Object({ profileId: Type.Integer() });

export const connectionDiscoveryResponse = discoveryResult;

export const connectionTestBody = testConnectionBody;

export const connectionTestResponse = testConnectionResult;

export const connectionCommandBody = commandBody;

// Stale-revision conflict carrying the authoritative current settings so
// the caller can recover without a follow-up read.
export const connectionSettingsConflict = Type.Object({
	outcome: Type.Literal("conflict"),
	expectedRevision: Type.Integer(),
	actualRevision: Type.Integer(),
	currentSettings: settings,
});

export const connectionSettingsApplied = Type.Object({
	outcome: Type.Literal("applied"),
	settings,
});

export const connectionInvalidResponse = invalidOutcome;
export const connectionNotFoundResponse = notFoundOutcome;

export type ConnectionProfileDraftPayload = Omit<Static<typeof profileDraft>, "backendOptions">;
export type ConnectionProfilePayload = Static<typeof profile>;
export type ConnectionSettingsPayload = Static<typeof settings>;
export type ConnectionPresetPayload = Static<typeof preset>;
export type ConnectionHeaderOperationPayload = Static<typeof headerOperation>;
export type ConnectionTestResultPayload = Static<typeof testConnectionResult>;
export type ConnectionDiscoveryResultPayload = Static<typeof discoveryResult>;

export type ConnectionSettingsCommandPayload =
	| {
			type: "create-profile";
			expectedRevision: number;
			profile: ConnectionProfileDraftPayload;
			credential?: string | null;
			headers?: ConnectionHeaderOperationPayload[];
	  }
	| {
			type: "apply-profile";
			expectedRevision: number;
			profileId: number;
			profile: ConnectionProfileDraftPayload;
			headers?: ConnectionHeaderOperationPayload[];
	  }
	| {
			type: "set-credential";
			expectedRevision: number;
			profileId: number;
			credential: string;
	  }
	| {
			type: "reset-credential";
			expectedRevision: number;
			profileId: number;
			confirmed: boolean;
	  }
	| {
			type: "activate-profile";
			expectedRevision: number;
			profileId: number;
	  }
	| {
			type: "delete-profile";
			expectedRevision: number;
			profileId: number;
			replacementProfileId?: number | null;
	  }
	| {
			type: "set-pinned-models";
			expectedRevision: number;
			profileId: number;
			pinnedModels: string[];
	  };

export type ConnectionTestDraftPayload = {
	profileId?: number;
	profile: ConnectionProfileDraftPayload;
	modelId: string;
	headers?: ConnectionHeaderOperationPayload[];
};

export type ConnectionSettingsCommandResultPayload =
	| { outcome: "applied"; settings: ConnectionSettingsPayload }
	| {
			outcome: "conflict";
			expectedRevision: number;
			actualRevision: number;
			currentSettings: ConnectionSettingsPayload;
	  }
	| { outcome: "invalid"; reason: string }
	| { outcome: "not-found" };
