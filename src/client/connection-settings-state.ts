import type {
	ConnectionProfile,
	ConnectionProfileDraft,
	ConnectionPreset,
	ConnectionSettings,
	ConnectionSettingsResult,
	TestConnectionResult,
} from "./connection-settings";
import {
	blankConnectionProfileDraft,
	connectionProfileDraftOf,
} from "../shared/contract/connection-settings";

export const emptyConnectionProfileDraft: ConnectionProfileDraft =
	connectionProfileDraftOf(blankConnectionProfileDraft);

export type HeaderEditorValue = {
	configured: boolean;
	operation: "keep" | "replace" | "remove";
	replacement: string;
};

export interface HeaderEditorData {
	[name: string]: HeaderEditorValue;
}

export type ConnectionSettingsConflict = Extract<
	ConnectionSettingsResult,
	{ outcome: "conflict" }
>;

/**
 * ==[HUMAN APPROVED]== Project the server-owned profile shape into the only shape accepted by
 * create/apply commands. Keeping this projection explicit prevents redacted
 * metadata and identifiers from leaking back across the API boundary.
 */
export function copyDraft(profile: ConnectionProfile | ConnectionProfileDraft): ConnectionProfileDraft {
	return connectionProfileDraftOf(profile);
}

export const headerEditorDataFor = (
	headers: ConnectionProfile["headers"],
): HeaderEditorData => {
	const data: HeaderEditorData = {};
	for (const header of headers) {
		data[header.name] = {
			configured: header.configured,
			operation: "keep",
			replacement: "",
		};
	}
	return data;
};

export type ConnectionSettingsControllerState = {
	settings: ConnectionSettings | null;
	presets: ConnectionPreset[];
	selectedProfileId: number | null;
	draft: ConnectionProfileDraft;
	credentialDraft: string;
	headerEditorData: HeaderEditorData;
	testModelId: string;
	testResult: TestConnectionResult | null;
	pendingDeletionProfileId: number | null;
	editorOpen: boolean;
	conflict: ConnectionSettingsConflict | null;
	notice: string | null;
	error: string | null;
	editorVersion: number;
	latestCommandId: number;
};

export const createConnectionSettingsControllerState = (): ConnectionSettingsControllerState => ({
	settings: null,
	presets: [],
	selectedProfileId: null,
	draft: connectionProfileDraftOf(blankConnectionProfileDraft),
	credentialDraft: "",
	headerEditorData: {},
	testModelId: "",
	testResult: null,
	pendingDeletionProfileId: null,
	editorOpen: false,
	conflict: null,
	notice: null,
	error: null,
	editorVersion: 0,
	latestCommandId: 0,
});

const editorChanged = (
	state: ConnectionSettingsControllerState,
	patch: Partial<ConnectionSettingsControllerState>,
): ConnectionSettingsControllerState => ({
	...state,
	...patch,
	editorVersion: state.editorVersion + 1,
});

const newerSettings = (
	current: ConnectionSettings | null,
	incoming: ConnectionSettings,
): ConnectionSettings => current === null || incoming.revision >= current.revision ? incoming : current;

const ownsEditorResult = (
	state: ConnectionSettingsControllerState,
	result: { editorVersion: number; commandId: number; settings: ConnectionSettings },
): boolean => result.editorVersion === state.editorVersion &&
	result.commandId === state.latestCommandId &&
	(state.settings === null || result.settings.revision >= state.settings.revision);

const profileEditorState = (
	state: ConnectionSettingsControllerState,
	profile: ConnectionProfile,
): ConnectionSettingsControllerState => ({
		...state,
		selectedProfileId: profile.id,
		draft: copyDraft(profile),
		credentialDraft: "",
		headerEditorData: headerEditorDataFor(profile.headers),
		testModelId: profile.pinnedModels[0] ?? "",
		testResult: null,
		pendingDeletionProfileId: null,
		editorOpen: true,
		conflict: null,
		notice: null,
		error: null,
	});

export type ConnectionSettingsControllerAction =
	| { type: "load-succeeded"; settings: ConnectionSettings; presets: ConnectionPreset[] }
	| { type: "load-failed"; message: string }
	| { type: "choose-preset"; preset: ConnectionPreset }
	| { type: "choose-profile"; profile: ConnectionProfile }
	| { type: "set-draft"; draft: ConnectionProfileDraft }
	| { type: "discard-draft" }
	| { type: "set-credential-draft"; value: string }
	| { type: "set-header-editor-data"; value: HeaderEditorData }
	| { type: "set-test-model-id"; value: string }
	| { type: "set-pending-deletion"; value: number | null }
	| { type: "request-deletion"; profileId: number }
	| { type: "clear-feedback" }
	| { type: "set-error"; message: string; commandId?: number }
	| { type: "command-started"; commandId: number }
	| { type: "test-started" }
	| { type: "test-succeeded"; result: TestConnectionResult }
	| { type: "test-failed"; message: string }
	| { type: "refresh-started" }
	| { type: "refresh-succeeded"; settings: ConnectionSettings; notice: string }
	| { type: "refresh-failed"; message: string }
	| { type: "command-conflict"; conflict: ConnectionSettingsConflict; message: string; commandId?: number }
	| { type: "apply-succeeded"; settings: ConnectionSettings; selectedProfileId: number | null; draftDisplayName: string; credentialWasProvided: boolean; editorVersion: number; commandId: number }
	| { type: "delete-succeeded"; settings: ConnectionSettings; deletedDisplayName: string; editorVersion: number; commandId: number }
	| { type: "reset-credential-succeeded"; settings: ConnectionSettings };

export function reduceConnectionSettingsController(
	state: ConnectionSettingsControllerState,
	action: ConnectionSettingsControllerAction,
): ConnectionSettingsControllerState {
	switch (action.type) {
		case "load-succeeded": {
			return { ...state, settings: newerSettings(state.settings, action.settings), presets: action.presets };
		}
		case "load-failed":
			return { ...state, error: action.message };
		case "choose-preset":
			return editorChanged(state, {
				selectedProfileId: null,
				draft: copyDraft(action.preset.profile),
				credentialDraft: "",
				headerEditorData: {},
				testModelId: action.preset.profile.pinnedModels[0] ?? "",
				testResult: null,
				pendingDeletionProfileId: null,
				editorOpen: true,
				conflict: null,
				notice: null,
				error: null,
			});
		case "choose-profile":
			return editorChanged(state, profileEditorState(state, action.profile));
		case "set-draft":
			return editorChanged(state, { draft: action.draft });
		case "discard-draft":
			return editorChanged(state, { selectedProfileId: null, draft: emptyConnectionProfileDraft, credentialDraft: "", headerEditorData: {}, editorOpen: false, notice: null, error: null, conflict: null });
		case "set-credential-draft":
			return editorChanged(state, { credentialDraft: action.value });
		case "set-header-editor-data":
			return editorChanged(state, { headerEditorData: action.value });
		case "set-test-model-id":
			return { ...state, testModelId: action.value };
		case "set-pending-deletion":
			return { ...state, pendingDeletionProfileId: action.value };
		case "request-deletion":
			return {
				...state,
				pendingDeletionProfileId: action.profileId,
				notice: null,
				error: null,
			};
		case "clear-feedback":
			return { ...state, notice: null, error: null };
		case "set-error":
			return action.commandId !== undefined && action.commandId !== state.latestCommandId
				? state
				: { ...state, error: action.message };
		case "command-started":
			return { ...state, latestCommandId: action.commandId };
		case "test-started":
			return { ...state, testResult: null, notice: null, error: null };
		case "test-succeeded":
			return { ...state, testResult: action.result };
		case "test-failed":
			return { ...state, error: action.message };
		case "refresh-started":
			return { ...state, notice: null, error: null };
		case "refresh-succeeded":
			return { ...state, settings: newerSettings(state.settings, action.settings), notice: action.notice, error: null };
		case "refresh-failed":
			return { ...state, error: action.message };
		case "command-conflict":
			return action.commandId !== undefined && action.commandId !== state.latestCommandId
				|| (state.settings !== null && action.conflict.actualRevision < state.settings.revision)
				? state
				: { ...state, settings: newerSettings(state.settings, action.conflict.currentSettings), conflict: action.conflict, error: action.message };
		case "apply-succeeded": {
			const authoritativeSettings = newerSettings(state.settings, action.settings);
			if (!ownsEditorResult(state, action) || action.selectedProfileId !== state.selectedProfileId) {
				return {
					...state,
					settings: authoritativeSettings,
				};
			}
			const saved = authoritativeSettings.profiles.find((profile) =>
				(action.selectedProfileId !== null && profile.id === action.selectedProfileId) ||
				(action.selectedProfileId === null && profile.displayName === action.draftDisplayName.trim().replace(/\s+/g, " ")),
			);
			const next = {
				...state,
				settings: authoritativeSettings,
				conflict: null,
				testResult: null,
				notice: action.selectedProfileId !== null && action.credentialWasProvided
					? "Profile changes saved. The credential draft is still unsaved."
					: "Changes saved. No provider request was made.",
				error: null,
			};
			return saved === undefined
				? next
				: {
						...next,
						selectedProfileId: saved.id,
						draft: copyDraft(saved),
						headerEditorData: headerEditorDataFor(saved.headers),
						credentialDraft: "",
					};
		}
		case "delete-succeeded": {
			if (!ownsEditorResult(state, action)) {
				return {
					...state,
					settings: newerSettings(state.settings, action.settings),
				};
			}
			return {
				...state,
				settings: newerSettings(state.settings, action.settings),
				conflict: null,
				pendingDeletionProfileId: null,
				notice: `${action.deletedDisplayName} deleted.`,
				error: null,
			};
		}
		case "reset-credential-succeeded":
			return { ...state, settings: newerSettings(state.settings, action.settings), conflict: null, notice: "Credential reset.", error: null };
	}
}

