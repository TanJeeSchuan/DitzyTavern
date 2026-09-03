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
	replacementProfileId: number | null;
	pendingDeletionProfileId: number | null;
	openProfileMenuId: number | null;
	presetChoicesOpen: boolean;
	conflict: ConnectionSettingsConflict | null;
	notice: string | null;
	error: string | null;
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
	replacementProfileId: null,
	pendingDeletionProfileId: null,
	openProfileMenuId: null,
	presetChoicesOpen: false,
	conflict: null,
	notice: null,
	error: null,
});

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
		replacementProfileId: state.settings?.profiles.find((entry) => entry.id !== profile.id)?.id ?? null,
		pendingDeletionProfileId: null,
	openProfileMenuId: null,
		presetChoicesOpen: false,
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
	| { type: "set-credential-draft"; value: string }
	| { type: "set-header-editor-data"; value: HeaderEditorData }
	| { type: "set-test-model-id"; value: string }
	| { type: "set-preset-choices-open"; value: boolean }
	| { type: "set-open-profile-menu"; value: number | null }
	| { type: "set-replacement-profile"; value: number | null }
	| { type: "set-pending-deletion"; value: number | null }
	| { type: "request-deletion"; profileId: number; replacementProfileId: number | null }
	| { type: "clear-feedback" }
	| { type: "set-error"; message: string }
	| { type: "test-started" }
	| { type: "test-succeeded"; result: TestConnectionResult }
	| { type: "test-failed"; message: string }
	| { type: "refresh-started" }
	| { type: "refresh-succeeded"; settings: ConnectionSettings; notice: string }
	| { type: "refresh-failed"; message: string }
	| { type: "command-conflict"; conflict: ConnectionSettingsConflict; message: string }
	| { type: "apply-succeeded"; settings: ConnectionSettings; selectedProfileId: number | null; draftDisplayName: string; credentialWasProvided: boolean }
	| { type: "credential-succeeded"; settings: ConnectionSettings }
	| { type: "activate-succeeded"; settings: ConnectionSettings }
	| { type: "delete-succeeded"; settings: ConnectionSettings; deletedDisplayName: string; replacementProfileId: number | null }
	| { type: "reset-credential-succeeded"; settings: ConnectionSettings };

export function reduceConnectionSettingsController(
	state: ConnectionSettingsControllerState,
	action: ConnectionSettingsControllerAction,
): ConnectionSettingsControllerState {
	switch (action.type) {
		case "load-succeeded": {
			const next = { ...state, settings: action.settings, presets: action.presets };
			const active = action.settings.profiles.find(
				(profile) => profile.id === action.settings.activeProfileId,
			);
			return active === undefined
				? next
				: profileEditorState(next, active);
		}
		case "load-failed":
			return { ...state, error: action.message };
		case "choose-preset":
			return {
				...state,
				selectedProfileId: null,
				draft: copyDraft(action.preset.profile),
				credentialDraft: "",
				headerEditorData: {},
				testModelId: action.preset.profile.pinnedModels[0] ?? "",
				testResult: null,
				replacementProfileId: null,
				pendingDeletionProfileId: null,
				openProfileMenuId: null,
				presetChoicesOpen: false,
				conflict: null,
				notice: `${action.preset.label} defaults copied into a new editable Profile draft.`,
				error: null,
			};
		case "choose-profile":
			return profileEditorState(state, action.profile);
		case "set-draft":
			return { ...state, draft: action.draft };
		case "set-credential-draft":
			return { ...state, credentialDraft: action.value };
		case "set-header-editor-data":
			return { ...state, headerEditorData: action.value };
		case "set-test-model-id":
			return { ...state, testModelId: action.value };
		case "set-preset-choices-open":
			return { ...state, presetChoicesOpen: action.value };
		case "set-open-profile-menu":
			return { ...state, openProfileMenuId: action.value };
		case "set-replacement-profile":
			return { ...state, replacementProfileId: action.value };
		case "set-pending-deletion":
			return { ...state, pendingDeletionProfileId: action.value };
		case "request-deletion":
			return {
				...state,
				pendingDeletionProfileId: action.profileId,
				replacementProfileId: action.replacementProfileId,
				openProfileMenuId: null,
				notice: null,
				error: null,
			};
		case "clear-feedback":
			return { ...state, notice: null, error: null };
		case "set-error":
			return { ...state, error: action.message };
		case "test-started":
			return { ...state, testResult: null, notice: null, error: null };
		case "test-succeeded":
			return action.result.outcome === "success"
				? { ...state, testResult: action.result, notice: action.result.message, error: null }
				: { ...state, testResult: action.result, notice: null, error: action.result.outcome === "failure" ? action.result.message : action.result.reason };
		case "test-failed":
			return { ...state, error: action.message };
		case "refresh-started":
			return { ...state, notice: null, error: null };
		case "refresh-succeeded":
			return { ...state, settings: action.settings, notice: action.notice, error: null };
		case "refresh-failed":
			return { ...state, error: action.message };
		case "command-conflict":
			return { ...state, settings: action.conflict.currentSettings, conflict: action.conflict, error: action.message };
		case "apply-succeeded": {
			const saved = action.settings.profiles.find((profile) =>
				(action.selectedProfileId !== null && profile.id === action.selectedProfileId) ||
				(action.selectedProfileId === null && profile.displayName === action.draftDisplayName.trim().replace(/\s+/g, " ")),
			);
			const next = {
				...state,
				settings: action.settings,
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
						credentialDraft: action.selectedProfileId === null ? "" : state.credentialDraft,
					};
		}
		case "credential-succeeded":
			return { ...state, settings: action.settings, credentialDraft: "", conflict: null, notice: "Credential updated.", error: null };
		case "activate-succeeded":
			return { ...state, settings: action.settings, conflict: null, notice: "Connection set as active for new generations.", error: null };
		case "delete-succeeded": {
			const nextProfile = action.settings.profiles.find(
				(profile) => profile.id === (action.replacementProfileId ?? action.settings.activeProfileId),
			);
			const next = {
				...state,
				settings: action.settings,
				conflict: null,
				pendingDeletionProfileId: null,
				credentialDraft: "",
				notice: `${action.deletedDisplayName} deleted.`,
				error: null,
			};
			return nextProfile === undefined
				? {
						...next,
						selectedProfileId: null,
						draft: connectionProfileDraftOf(blankConnectionProfileDraft),
						headerEditorData: {},
						testModelId: "",
						testResult: null,
						replacementProfileId: null,
					}
				: { ...profileEditorState(next, nextProfile), notice: next.notice };
		}
		case "reset-credential-succeeded":
			return { ...state, settings: action.settings, conflict: null, notice: "Credential reset.", error: null };
	}
}

