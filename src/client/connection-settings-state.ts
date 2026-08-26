import type {
	ConnectionProfile,
	ConnectionProfileDraft,
	ConnectionSettings,
	ConnectionSettingsResult,
} from "./connection-settings";

export type ConnectionSettingsConflict = Extract<
	ConnectionSettingsResult,
	{ outcome: "conflict" }
>;

/**
 * Project the server-owned profile shape into the only shape accepted by
 * create/apply commands. Keeping this projection explicit prevents redacted
 * metadata and identifiers from leaking back across the API boundary.
 */
export function copyDraft(profile: ConnectionProfile | ConnectionProfileDraft): ConnectionProfileDraft {
	return {
		displayName: profile.displayName,
		apiFormat: profile.apiFormat,
		requestUrl: profile.requestUrl,
		modelsUrl: profile.modelsUrl,
		modelBackend: profile.modelBackend,
		adapter: profile.adapter,
		outputTokenRepresentation: profile.outputTokenRepresentation,
		timeoutMs: profile.timeoutMs,
		pinnedModels: [...profile.pinnedModels],
	};
}

export type ConnectionSettingsEditorState = {
	readonly settings: ConnectionSettings;
	readonly selectedProfileId: number | null;
	readonly draft: ConnectionProfileDraft;
	readonly credentialDraft: string;
	readonly conflict: ConnectionSettingsConflict | null;
};

export function preserveConnectionDraftOnConflict(
	state: ConnectionSettingsEditorState,
	conflict: ConnectionSettingsConflict,
): ConnectionSettingsEditorState {
	return {
		...state,
		settings: conflict.currentSettings,
		conflict,
	};
}
