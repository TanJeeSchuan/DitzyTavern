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

/** @approved
 * Project the server-owned profile shape into the only shape accepted by
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
	editorIdentity: symbol;
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
};

export const createConnectionSettingsControllerState = (): ConnectionSettingsControllerState => ({
	editorIdentity: Symbol(),
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
});

// @approved
//  Every settings snapshot enters the query cache through this fold, so a
//  late command result can never replace a newer authoritative revision.
export const newerSettings = (
	current: ConnectionSettings | null,
	incoming: ConnectionSettings,
): ConnectionSettings => current === null || incoming.revision >= current.revision ? incoming : current;

export type ConnectionSettingsEditorSnapshot = Pick<ConnectionSettingsControllerState, "editorIdentity" | "selectedProfileId">;

const profileEditorState = (
	state: ConnectionSettingsControllerState,
	profile: ConnectionProfile,
): ConnectionSettingsControllerState => ({
		...state,
		editorIdentity: Symbol(),
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
	| { type: "set-error"; message: string }
	| { type: "test-started" }
	| { type: "test-succeeded"; result: TestConnectionResult }
	| { type: "test-failed"; message: string }
	| { type: "refresh-started" }
	| { type: "refresh-succeeded"; notice: string }
	| { type: "refresh-failed"; message: string }
	| { type: "command-conflict"; conflict: ConnectionSettingsConflict; message: string }
	| { type: "apply-succeeded"; settings: ConnectionSettings; submitted: ConnectionSettingsEditorSnapshot; draftDisplayName: string }
	| { type: "delete-succeeded"; deletedDisplayName: string }
	| { type: "reset-credential-succeeded" };

export function reduceConnectionSettingsController(
	state: ConnectionSettingsControllerState,
	action: ConnectionSettingsControllerAction,
): ConnectionSettingsControllerState {
	switch (action.type) {
		case "choose-preset":
			return {
				...state,
				editorIdentity: Symbol(),
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
			};
		case "choose-profile":
			return profileEditorState(state, action.profile);
		case "set-draft":
			return { ...state, editorIdentity: Symbol(), draft: action.draft };
		case "discard-draft":
			return {
				...state, editorIdentity: Symbol(), selectedProfileId: null, draft: emptyConnectionProfileDraft,
				credentialDraft: "", headerEditorData: {}, editorOpen: false, notice: null, error: null, conflict: null,
			};
		case "set-credential-draft":
			return { ...state, editorIdentity: Symbol(), credentialDraft: action.value };
		case "set-header-editor-data":
			return { ...state, editorIdentity: Symbol(), headerEditorData: action.value };
		case "set-test-model-id":
			return { ...state, editorIdentity: Symbol(), testModelId: action.value };
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
			return { ...state, error: action.message };
		case "test-started":
			return { ...state, testResult: null, notice: null, error: null };
		case "test-succeeded":
			return { ...state, testResult: action.result };
		case "test-failed":
			return { ...state, error: action.message };
		case "refresh-started":
			return { ...state, notice: null, error: null };
		case "refresh-succeeded":
			return { ...state, notice: action.notice, error: null };
		case "refresh-failed":
			return { ...state, error: action.message };
		case "command-conflict":
			return { ...state, conflict: action.conflict, error: action.message };
		case "apply-succeeded": {
			if (state.editorIdentity !== action.submitted.editorIdentity) return state;
			const saved = action.settings.profiles.find((profile) =>
				(action.submitted.selectedProfileId !== null && profile.id === action.submitted.selectedProfileId) ||
				(action.submitted.selectedProfileId === null && profile.displayName === action.draftDisplayName.trim().replace(/\s+/g, " ")),
			);
			const next = {
				...state,
				editorIdentity: Symbol(),
				conflict: null,
				testResult: null,
				notice: "Changes saved. No provider request was made.",
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
		case "delete-succeeded":
			return {
				...state,
				conflict: null,
				pendingDeletionProfileId: null,
				notice: `${action.deletedDisplayName} deleted.`,
				error: null,
			};
		case "reset-credential-succeeded":
			return { ...state, conflict: null, notice: "Credential reset.", error: null };
	}
}
