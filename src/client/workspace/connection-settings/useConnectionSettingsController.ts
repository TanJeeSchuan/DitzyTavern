import { useMemo, useReducer, useRef, useState } from "react";
import {
	loadConnectionPresets,
	loadConnectionSettings,
	refreshDiscoveryCatalog,
	saveConnectionCommand,
	testConnectionDraft,
	type ConnectionHeaderOperation,
	type ConnectionProfile,
	type ConnectionProfileDraft,
	type ConnectionPreset,
	type ConnectionSettings,
	type ConnectionSettingsCommand,
	type ConnectionSettingsResult,
	type TestConnectionDraftInput,
	type TestConnectionResult,
} from "../../connection-settings";
import {
	createConnectionSettingsControllerState,
	reduceConnectionSettingsController,
		type ConnectionSettingsConflict,
	type HeaderEditorData,
	copyDraft,
	headerEditorDataFor,
} from "../../connection-settings-state";
import { connectionDraftValidationError } from "../../connection-settings-draft";
import { useAsyncEffect } from "../../lib/use-async";
import { resolveRequestUrl } from "../../../shared/connection-url";

export function headerOperationsFor(data: HeaderEditorData): ConnectionHeaderOperation[] {
	return Object.entries(data).map(([name, value]) => {
		if (value.operation === "replace") return { name, operation: "replace", value: value.replacement };
		if (value.operation === "remove") return { name, operation: "remove" };
		return { name, operation: "keep" };
	});
}

// @approved
//  The command-failure wording shared by every Profile command handler; the
// conflict variant is passed per command because it names what was preserved.
const APPLY_CONFLICT_ERROR = "These settings changed elsewhere. Your unsaved draft is preserved.";
const PROFILE_NOT_FOUND_ERROR = "The selected Profile no longer exists.";

type AppliedConnectionSettings = Extract<ConnectionSettingsResult, { outcome: "applied" }>;

export type ConnectionSettingsController = {
	settings: ConnectionSettings | null;
	presets: ConnectionPreset[];
	loading: boolean;
	selectedProfileId: number | null;
	draft: ConnectionProfileDraft;
	credentialDraft: string;
	headerEditorData: HeaderEditorData;
	testModelId: string;
	testResult: TestConnectionResult | null;
	testPending: boolean;
	discoveryPending: boolean;
	pendingDeletionProfileId: number | null;
	editorOpen: boolean;
	canSave: boolean;
	dirty: boolean;
	saving: boolean;
	validationError: string | null;
	conflict: ConnectionSettingsConflict | null;
	notice: string | null;
	error: string | null;
	selectedProfile: ConnectionProfile | undefined;
	pendingDeletionProfile: ConnectionProfile | undefined;
	refreshModelsDisabledReason: string | undefined;
	resolvedRequestUrl: string;
	choosePreset: (preset: ConnectionPreset) => void;
	chooseProfile: (profile: ConnectionProfile) => void;
	duplicateProfile: (profile: ConnectionProfile) => void;
	closeEditor: () => void;
	setDraft: (draft: ConnectionProfileDraft) => void;
	setCredentialDraft: (value: string) => void;
	setHeaderEditorData: (value: HeaderEditorData) => void;
	setTestModelId: (value: string) => void;
	setPendingDeletionProfileId: (value: number | null) => void;
	testDraft: () => Promise<void>;
	refreshModels: () => Promise<void>;
	applyDraft: () => Promise<boolean>;
	discardDraft: () => void;
	requestProfileDeletion: (profile: ConnectionProfile) => void;
	deletePendingProfile: () => Promise<void>;
	resetCredential: () => Promise<void>;
};

/** @approved
 * Owns the Connection Settings editor state. The former single patch-any-field
 * store is split into focused slices — server catalog, editable Profile
 * draft, selection and menus, and user-facing feedback — and the Profile
 * command handlers share one runConnectionCommand failure path.
 */
export function useConnectionSettingsController(): ConnectionSettingsController {
	const [state, dispatch] = useReducer(
		reduceConnectionSettingsController,
		undefined,
		createConnectionSettingsControllerState,
	);
	const {
		settings,
		presets,
		selectedProfileId,
		draft,
		credentialDraft,
		headerEditorData,
		testModelId,
		testResult,
		pendingDeletionProfileId,
		editorOpen,
		conflict,
		notice,
		error,
		editorVersion,
	} = state;
	const [loading, setLoading] = useState(true);
	const [testPending, setTestPending] = useState(false);
	const [discoveryPending, setDiscoveryPending] = useState(false);
	const [saving, setSaving] = useState(false);
	const commandIdRef = useRef(0);
	const editorVersionRef = useRef(editorVersion);
	editorVersionRef.current = editorVersion;

	const setDraft = (value: ConnectionProfileDraft) => dispatch({ type: "set-draft", draft: value });
	const setCredentialDraft = (value: string) => dispatch({ type: "set-credential-draft", value });
	const setHeaderEditorData = (value: HeaderEditorData) => dispatch({ type: "set-header-editor-data", value });
	const setTestModelId = (value: string) => dispatch({ type: "set-test-model-id", value });
	const setPendingDeletionProfileId = (value: number | null) => dispatch({ type: "set-pending-deletion", value });

	useAsyncEffect((isCancelled) => {
		void Promise.all([loadConnectionSettings(), loadConnectionPresets()])
			.then(([loadedSettings, loadedPresets]) => {
				if (isCancelled()) return;
				dispatch({ type: "load-succeeded", settings: loadedSettings, presets: loadedPresets });
			})
			.catch(() => {
				if (!isCancelled()) dispatch({ type: "load-failed", message: "Connection Settings could not be loaded." });
			})
			.finally(() => {
				if (!isCancelled()) setLoading(false);
			});
	}, []);

	const selectedProfile = settings?.profiles.find((profile) => profile.id === selectedProfileId);
	const pendingDeletionProfile = settings?.profiles.find((profile) => profile.id === pendingDeletionProfileId);
	const refreshModelsDisabledReason = selectedProfileId === null
		? "Save this connection before refreshing."
		: draft.modelsUrl.trim().length === 0
			? "Enter a Models URL before refreshing."
			: selectedProfile?.modelsUrl.trim() !== draft.modelsUrl.trim()
				? "Save the Models URL before refreshing."
				: discoveryPending
					? "A model refresh is already in progress."
					: undefined;
	const resolvedRequestUrl = useMemo(() => {
		if (draft.requestUrl.trim().length === 0) return "";
		try {
			return resolveRequestUrl(draft.requestUrl, draft.apiFormat);
		} catch (error) {
			return error instanceof Error ? `Invalid: ${error.message}` : "Invalid request URL";
		}
	}, [draft.apiFormat, draft.requestUrl]);
	const validationError = connectionDraftValidationError(draft, headerEditorData);
	const canSave = settings !== null && validationError === null;
	const dirty = editorOpen && (selectedProfile === undefined || JSON.stringify(draft) !== JSON.stringify(copyDraft(selectedProfile)) || JSON.stringify(headerEditorData) !== JSON.stringify(headerEditorDataFor(selectedProfile.headers)) || credentialDraft.length > 0);

	// @approved
	//  Runs one Connection Settings command and owns the failure wording
	// repeated by every Profile command handler: a conflict preserves the
	// editor state in the reducer, an invalid outcome surfaces the
	// server reason, and anything else reads as a missing Profile. Returns
	// the applied result, or null after the error slice is set.
	const runConnectionCommand = async (
		command: () => Promise<ConnectionSettingsResult>,
		conflictError: string,
		commandId?: number,
	): Promise<AppliedConnectionSettings | null> => {
		const result = await command();
		if (result.outcome === "applied") return result;
		if (result.outcome === "conflict") {
			dispatch({ type: "command-conflict", conflict: result, message: conflictError, commandId });
		} else {
				dispatch({
					type: "set-error",
					message: result.outcome === "invalid" ? result.reason : PROFILE_NOT_FOUND_ERROR,
					commandId,
			});
		}
		return null;
	};

	const choosePreset = (preset: ConnectionPreset) => {
		dispatch({ type: "choose-preset", preset });
	};

	const chooseProfile = (profile: ConnectionProfile) => {
		dispatch({ type: "choose-profile", profile });
	};

	const duplicateProfile = (profile: ConnectionProfile) => dispatch({
		type: "choose-preset",
		preset: { id: `profile-${profile.id}`, label: profile.displayName, description: "", profile: { ...copyDraft(profile), displayName: `${profile.displayName} copy` } },
	});

	const closeEditor = () => dispatch({ type: "discard-draft" });

	const testDraft = async () => {
		if (validationError !== null) {
			dispatch({ type: "set-error", message: validationError });
			return;
		}
		if (testModelId.trim().length === 0) {
			dispatch({ type: "set-error", message: "Enter a model ID before testing this Connection Profile." });
			return;
		}
		setTestPending(true);
		dispatch({ type: "test-started" });
		try {
			const request: TestConnectionDraftInput = {
				profile: draft,
				modelId: testModelId,
				headers: headerOperationsFor(headerEditorData),
			};
			if (selectedProfileId !== null) request.profileId = selectedProfileId;
			const result = await testConnectionDraft(request);
			dispatch({ type: "test-succeeded", result });
		} catch {
			dispatch({ type: "test-failed", message: "Test Connection could not be completed." });
		} finally {
			setTestPending(false);
		}
	};

	const refreshModels = async () => {
		if (selectedProfileId === null) { dispatch({ type: "set-error", message: "Save this connection before refreshing its Models URL." }); return; }
		if (draft.modelsUrl.trim().length === 0) { dispatch({ type: "set-error", message: "Refresh requires an exact Models URL." }); return; }
		if (selectedProfile?.modelsUrl.trim() !== draft.modelsUrl.trim()) { dispatch({ type: "set-error", message: "Save the Models URL change before refreshing the catalog." }); return; }
		setDiscoveryPending(true);
		dispatch({ type: "refresh-started" });
		try {
			const result = await refreshDiscoveryCatalog(selectedProfileId);
			if (result.outcome === "success") {
				if (settings !== null) dispatch({ type: "refresh-succeeded", settings: { ...settings, profiles: settings.profiles.map((profile) => profile.id === result.profile.id ? result.profile : profile) }, notice: `Model catalog refreshed. ${result.profile.discoveryCatalog.length} model IDs are available for autocomplete.` });
			} else if (result.outcome === "failure") dispatch({ type: "refresh-failed", message: result.message });
			else if (result.outcome === "invalid") dispatch({ type: "refresh-failed", message: result.reason });
			else if (result.outcome === "conflict") {
				dispatch({ type: "command-conflict", conflict: result, message: "Connection Settings changed while models were refreshing. Your draft is preserved." });
			}
			else dispatch({ type: "refresh-failed", message: PROFILE_NOT_FOUND_ERROR });
		} catch { dispatch({ type: "refresh-failed", message: "Model catalog refresh could not be completed." }); }
		finally { setDiscoveryPending(false); }
	};

	const applyDraft = async () => {
		if (settings === null) return false;
		if (validationError !== null) {
			dispatch({ type: "set-error", message: validationError });
			return false;
		}
		let headers: ConnectionHeaderOperation[];
		try { headers = headerOperationsFor(headerEditorData); }
		catch { dispatch({ type: "set-error", message: "Custom header drafts are invalid." }); return false; }
		dispatch({ type: "clear-feedback" });
		const appliedProfileId = selectedProfileId;
		const appliedDraftDisplayName = draft.displayName;
		const requestEditorVersion = editorVersion;
		const commandId = ++commandIdRef.current;
		setSaving(true);
		dispatch({ type: "command-started", commandId });
		const command: ConnectionSettingsCommand = selectedProfileId === null
			? { type: "create-profile", expectedRevision: settings.revision, profile: draft, credential: credentialDraft.length > 0 ? credentialDraft : null, headers }
			: { type: "apply-profile", expectedRevision: settings.revision, profileId: selectedProfileId, profile: draft, headers };
		if (credentialDraft.length > 0) command.credential = credentialDraft;
		try {
		const applied = await runConnectionCommand(
			() => saveConnectionCommand(command),
			APPLY_CONFLICT_ERROR,
			commandId,
		);
		if (applied === null) return false;
		dispatch({
			type: "apply-succeeded",
			settings: applied.settings,
			selectedProfileId: appliedProfileId,
			draftDisplayName: appliedDraftDisplayName,
			credentialWasProvided: false,
			editorVersion: requestEditorVersion,
			commandId,
		});
		return editorVersionRef.current === requestEditorVersion;
		} catch { dispatch({ type: "set-error", message: "Connection settings could not be saved." }); return false; }
		finally { setSaving(false); }
	};
	const discardDraft = () => selectedProfile === undefined ? dispatch({ type: "discard-draft" }) : dispatch({ type: "choose-profile", profile: selectedProfile });

	const requestProfileDeletion = (profile: ConnectionProfile) => {
		dispatch({
			type: "request-deletion",
			profileId: profile.id,
		});
	};

	const deletePendingProfile = async () => {
		if (settings === null || pendingDeletionProfileId === null || !pendingDeletionProfile) return;
		dispatch({ type: "clear-feedback" });
		const deletedDisplayName = pendingDeletionProfile.displayName;
		const requestEditorVersion = editorVersion;
		const commandId = ++commandIdRef.current;
		dispatch({ type: "command-started", commandId });
		const applied = await runConnectionCommand(
			() => saveConnectionCommand({ type: "delete-profile", expectedRevision: settings.revision, profileId: pendingDeletionProfile.id }),
			APPLY_CONFLICT_ERROR,
			commandId,
		);
		if (applied === null) return;
		dispatch({
			type: "delete-succeeded",
			settings: applied.settings,
			deletedDisplayName,
			editorVersion: requestEditorVersion,
			commandId,
		});
	};

	const resetCredential = async () => {
		if (settings === null || selectedProfileId === null) return;
		dispatch({ type: "clear-feedback" });
		let result: ConnectionSettingsResult;
		try {
			result = await saveConnectionCommand({ type: "reset-credential", expectedRevision: settings.revision, profileId: selectedProfileId, confirmed: true });
		} catch {
			dispatch({ type: "set-error", message: "Credential reset failed." });
			return;
		}
		// @approved
		//  Reset deliberately skips preserveConflict: the credential draft is
		// cleared either way, so a conflict reads as a plain failure here.
		if (result.outcome !== "applied") { dispatch({ type: "set-error", message: result.outcome === "invalid" ? result.reason : "Credential reset failed." }); return; }
		dispatch({ type: "reset-credential-succeeded", settings: result.settings });
	};

	return {
		settings,
		presets,
		loading,
		selectedProfileId,
		draft,
		credentialDraft,
		headerEditorData,
		testModelId,
		testResult,
		testPending,
		discoveryPending,
		pendingDeletionProfileId,
		editorOpen,
		canSave,
		dirty,
		saving,
		validationError,
		conflict,
		notice,
		error,
		selectedProfile,
		pendingDeletionProfile,
		refreshModelsDisabledReason,
		resolvedRequestUrl,
		choosePreset,
		chooseProfile,
		duplicateProfile,
		closeEditor,
		setDraft,
		setCredentialDraft,
		setHeaderEditorData,
		setTestModelId,
		setPendingDeletionProfileId,
		testDraft,
		refreshModels,
		applyDraft,
		discardDraft,
		requestProfileDeletion,
		deletePendingProfile,
		resetCredential,
	};
}
