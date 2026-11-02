import { reduceDraft, type DraftEvent, type DraftSession, type Revisioned } from "./lib/revisioned-draft";
import type {
	ConnectionProfile,
	ConnectionProfileDraft,
	ConnectionPreset,
	ConnectionSettings,
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

/** @approved The part of the Profile editor a save writes: its fields, a replacement credential, and header changes. */
export interface ProfileEdit {
	draft: ConnectionProfileDraft;
	credentialDraft: string;
	headerEditorData: HeaderEditorData;
}

const sameEdit = (left: ProfileEdit, right: ProfileEdit) => JSON.stringify(left) === JSON.stringify(right);
/** @approved The edit a new Profile starts from, so a preset's fields are its unsaved changes. */
export const blankEdit: ProfileEdit = { draft: emptyConnectionProfileDraft, credentialDraft: "", headerEditorData: {} };
export const editOf = (profile: ConnectionProfile): ProfileEdit => ({ draft: copyDraft(profile), credentialDraft: "", headerEditorData: headerEditorDataFor(profile.headers) });

export type ConnectionSettingsControllerState = {
	selectedProfileId: number | null;
	// @approved
	//  The open editor's revisioned draft, null while no editor is open. A new
	// Profile drafts against the blank edit at the settings revision it opened at.
	session: DraftSession<ProfileEdit> | null;
	testModelId: string;
	testResult: TestConnectionResult | null;
	pendingDeletionProfileId: number | null;
	notice: string | null;
	error: string | null;
};

export const createConnectionSettingsControllerState = (): ConnectionSettingsControllerState => ({
	selectedProfileId: null,
	session: null,
	testModelId: "",
	testResult: null,
	pendingDeletionProfileId: null,
	notice: null,
	error: null,
});

/** @approved The edit the open editor shows. */
export const editIn = (state: ConnectionSettingsControllerState): ProfileEdit => {
	const { session } = state;
	return session === null ? blankEdit : session.status === "clean" ? session.base.value : session.mine;
};

// @approved
//  What a test result describes: the selected Profile, the edit, and the model
// tested. A result started for another key is dropped, and a change of key clears it.
export const testedEditor = (state: ConnectionSettingsControllerState) => JSON.stringify([state.selectedProfileId, editIn(state), state.testModelId]);

const openEditor = (state: ConnectionSettingsControllerState, selectedProfileId: number | null, session: DraftSession<ProfileEdit> | null, testModelId: string): ConnectionSettingsControllerState => ({
	...state, selectedProfileId, session, testModelId, testResult: null, pendingDeletionProfileId: null, notice: null, error: null,
});
const draftEvent = (state: ConnectionSettingsControllerState, event: DraftEvent<ProfileEdit>) => {
	const session = reduceDraft(state.session, event, sameEdit);
	return session === state.session ? state : { ...state, session };
};
const edit = (state: ConnectionSettingsControllerState, patch: Partial<ProfileEdit>) => draftEvent(state, { type: "edited", mine: { ...editIn(state), ...patch } });
const savingClaims = (state: ConnectionSettingsControllerState, submitted: ProfileEdit) => state.session?.status === "saving" && state.session.submitted === submitted;

export type ConnectionSettingsControllerAction =
	| { type: "choose-preset"; preset: ConnectionPreset; revision: number }
	| { type: "choose-profile"; profile: ConnectionProfile; revision: number }
	| { type: "observed"; server: Revisioned<ProfileEdit> }
	| { type: "set-draft"; draft: ConnectionProfileDraft }
	| { type: "close-editor" }
	| { type: "discard-draft" }
	| { type: "keep-mine" }
	| { type: "set-credential-draft"; value: string }
	| { type: "set-header-editor-data"; value: HeaderEditorData }
	| { type: "set-test-model-id"; value: string }
	| { type: "set-pending-deletion"; value: number | null }
	| { type: "request-deletion"; profileId: number }
	| { type: "clear-feedback" }
	| { type: "set-error"; message: string }
	| { type: "test-started" }
	| { type: "test-succeeded"; editor: string; result: TestConnectionResult }
	| { type: "test-failed"; editor: string; message: string }
	| { type: "refresh-started" }
	| { type: "refresh-succeeded"; notice: string }
	| { type: "refresh-failed"; message: string }
	| { type: "apply-started"; submitted: ProfileEdit }
	| { type: "apply-succeeded"; settings: ConnectionSettings; submitted: ProfileEdit }
	| { type: "apply-conflicted"; submitted: ProfileEdit; theirs: Revisioned<ProfileEdit>; message: string }
	| { type: "apply-failed"; submitted: ProfileEdit; message: string }
	| { type: "delete-succeeded"; deletedProfileId: number; deletedDisplayName: string }
	| { type: "reset-credential-succeeded" };

export function reduceConnectionSettingsController(
	state: ConnectionSettingsControllerState,
	action: ConnectionSettingsControllerAction,
): ConnectionSettingsControllerState {
	const next = reduceEditor(state, action);
	return next.testResult === null || testedEditor(next) === testedEditor(state) ? next : { ...next, testResult: null };
}

function reduceEditor(
	state: ConnectionSettingsControllerState,
	action: ConnectionSettingsControllerAction,
): ConnectionSettingsControllerState {
	switch (action.type) {
		case "choose-preset": {
			const opened = reduceDraft(null, { type: "observed", server: { value: blankEdit, revision: action.revision } }, sameEdit);
			const session = reduceDraft(opened, { type: "edited", mine: { ...blankEdit, draft: copyDraft(action.preset.profile) } }, sameEdit);
			return openEditor(state, null, session, action.preset.profile.pinnedModels[0] ?? "");
		}
		case "choose-profile":
			return openEditor(state, action.profile.id, { status: "clean", base: { value: editOf(action.profile), revision: action.revision } }, action.profile.pinnedModels[0] ?? "");
		case "observed":
			return draftEvent(state, { type: "observed", server: action.server });
		case "set-draft":
			return edit(state, { draft: action.draft });
		case "close-editor":
			return { ...state, selectedProfileId: null, session: null, notice: null, error: null };
		case "discard-draft":
			if (state.selectedProfileId === null) return reduceEditor(state, { type: "close-editor" });
			return { ...draftEvent(state, { type: "discarded" }), notice: null, error: null };
		case "keep-mine":
			return draftEvent(state, { type: "kept-mine" });
		case "set-credential-draft":
			return edit(state, { credentialDraft: action.value });
		case "set-header-editor-data":
			return edit(state, { headerEditorData: action.value });
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
			return { ...state, error: action.message };
		case "test-started":
			return { ...state, testResult: null, notice: null, error: null };
		case "test-succeeded":
			return action.editor === testedEditor(state) ? { ...state, testResult: action.result } : state;
		case "test-failed":
			return action.editor === testedEditor(state) ? { ...state, error: action.message } : state;
		case "refresh-started":
			return { ...state, notice: null, error: null };
		case "refresh-succeeded":
			return { ...state, notice: action.notice, error: null };
		case "refresh-failed":
			return { ...state, error: action.message };
		case "apply-started":
			return { ...draftEvent(state, { type: "save-started", submitted: action.submitted }), notice: null, error: null };
		case "apply-succeeded": {
			if (!savingClaims(state, action.submitted) || state.session?.status !== "saving") return state;
			const { edited } = state.session;
			const name = action.submitted.draft.displayName.trim().replace(/\s+/g, " ");
			const saved = action.settings.profiles.find((profile) => state.selectedProfileId === null ? profile.displayName === name : profile.id === state.selectedProfileId);
			const notice = edited ? state.notice : "Changes saved. No provider request was made.";
			if (saved === undefined) return { ...draftEvent(state, { type: "failed", submitted: action.submitted }), notice, error: null };
			// @approved
			//  A new Profile had no identity while it saved, so what arrived meanwhile
			// was the blank edit; the created Profile follows newer copies once selected.
			const settling = state.selectedProfileId === null ? { ...state, session: { ...state.session, seen: null } } : state;
			const next = draftEvent(settling, { type: "saved", submitted: action.submitted, saved: { value: editOf(saved), revision: action.settings.revision } });
			return { ...next, selectedProfileId: saved.id, notice, error: null };
		}
		case "apply-conflicted": {
			if (!savingClaims(state, action.submitted)) return state;
			const next = draftEvent(state, { type: "conflicted", submitted: action.submitted, theirs: action.theirs });
			return next.session?.status === "conflict" ? next : { ...next, error: action.message };
		}
		case "apply-failed":
			return { ...draftEvent(state, { type: "failed", submitted: action.submitted }), error: action.message };
		case "delete-succeeded":
			if (state.pendingDeletionProfileId !== null && state.pendingDeletionProfileId !== action.deletedProfileId) return state;
			return {
				...state,
				pendingDeletionProfileId: null,
				notice: `${action.deletedDisplayName} deleted.`,
				error: null,
			};
		case "reset-credential-succeeded":
			return { ...state, notice: "Credential reset.", error: null };
	}
}
