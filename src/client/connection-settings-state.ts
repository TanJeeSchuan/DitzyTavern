import type {
	ConnectionProfileDraft,
	ConnectionSettings,
	ConnectionSettingsResult,
} from "./connection-settings";

export type ConnectionSettingsConflict = Extract<
	ConnectionSettingsResult,
	{ outcome: "conflict" }
>;

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
