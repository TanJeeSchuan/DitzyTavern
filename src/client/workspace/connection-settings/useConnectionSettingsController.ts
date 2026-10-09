import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useReducer } from "react";
import {
	loadConnectionPresets,
	refreshDiscoveryCatalog,
	saveConnectionCommand,
	testConnectionDraft,
	type ConnectionHeaderOperation,
	type ConnectionProfile,
	type ConnectionProfileDraft,
	type ConnectionPreset,
	type ConnectionSettings,
	type ConnectionSettingsCommand,
	type TestConnectionDraftInput,
	type TestConnectionResult,
} from "../../connection-settings";
import {
	createConnectionSettingsControllerState,
	reduceConnectionSettingsController,
	type ConnectionSettingsConflict,
	type ConnectionSettingsEditorSnapshot,
	type HeaderEditorData,
	copyDraft,
	headerEditorDataFor,
} from "../../connection-settings-state";
import { connectionSettingsKey as settingsKey, publishConnectionSettings, useConnectionSettingsQuery } from "../../connection-settings-query";
import { connectionDraftValidationError } from "../../connection-settings-draft";
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
const LOAD_ERROR = "Connection Settings could not be loaded.";

// @approved
//  One submission shape per Profile command family, so the shared command
// mutation can adopt the server's copy for the editor that sent it.
type ConnectionCommandSubmission =
	| { type: "apply"; command: ConnectionSettingsCommand; draftDisplayName: string; submitted: ConnectionSettingsEditorSnapshot }
	| { type: "delete"; command: ConnectionSettingsCommand; deletedDisplayName: string }
	| { type: "reset-credential"; command: ConnectionSettingsCommand };


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
 * Owns the Connection Settings editor: the server catalog lives in the
 * react-query cache, while this hook reduces the focused slices the editor
 * edits — Profile draft, selection and menus, test result, and user-facing
 * feedback. The Profile command handlers share one command mutation.
 */
export function useConnectionSettingsController(): ConnectionSettingsController {
	const client = useQueryClient();
	const [state, dispatch] = useReducer(
		reduceConnectionSettingsController,
		undefined,
		createConnectionSettingsControllerState,
	);
	const {
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
	} = state;
	const settingsQuery = useConnectionSettingsQuery();
	const presetsQuery = useQuery({
		queryKey: ["connection-settings", "presets"],
		staleTime: Infinity,
		queryFn: async ({ signal }) => {
			await Promise.resolve();
			signal.throwIfAborted();
			return loadConnectionPresets(signal);
		},
	});
	const settings = settingsQuery.data ?? null;
	const presets = presetsQuery.data ?? [];
	const loadError = settingsQuery.isError || presetsQuery.isError ? LOAD_ERROR : null;
	// @approved
	//  A conflict carries the revision it saw; when the cache already holds a
	//  newer one the conflict is stale and only its snapshot is folded in.
	const conflictIsStale = (actualRevision: number): boolean => {
		const current = client.getQueryData<ConnectionSettings>(settingsKey);
		return current !== undefined && actualRevision < current.revision;
	};

	const command = useMutation({
		mutationKey: ["connection-settings", "command"],
		mutationFn: (submission: ConnectionCommandSubmission) => saveConnectionCommand(submission.command),
			onSuccess: (result, submission) => {
			if (result.outcome === "conflict") {
				publishConnectionSettings(client, result.currentSettings);
				if (submission.type === "reset-credential") dispatch({ type: "set-error", message: "Credential reset failed." });
				else if (!conflictIsStale(result.actualRevision)) dispatch({ type: "command-conflict", conflict: result, message: APPLY_CONFLICT_ERROR });
				return;
			}
			if (result.outcome !== "available") {
				dispatch({
					type: "set-error",
					message: result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : result.outcome === "network" ? "The connection could not be reached." : PROFILE_NOT_FOUND_ERROR,
				});
				return;
			}
			const applied = publishConnectionSettings(client, result.value.settings) ?? result.value.settings;
			if (submission.type === "apply") dispatch({ type: "apply-succeeded", settings: applied, draftDisplayName: submission.draftDisplayName, submitted: submission.submitted });
			else if (submission.type === "delete") dispatch({ type: "delete-succeeded", deletedDisplayName: submission.deletedDisplayName });
			else dispatch({ type: "reset-credential-succeeded" });
		},
		onError: () => dispatch({ type: "set-error", message: "Connection settings could not be saved." }),
	});
	const test = useMutation({
		mutationKey: ["connection-settings", "test"],
		mutationFn: testConnectionDraft,
		onSuccess: (result) => dispatch({ type: "test-succeeded", result }),
		onError: () => dispatch({ type: "test-failed", message: "Test Connection could not be completed." }),
	});
	const refresh = useMutation({
		mutationKey: ["connection-settings", "discovery"],
		mutationFn: refreshDiscoveryCatalog,
		onSuccess: (result) => {
			if (result.outcome === "conflict") {
				publishConnectionSettings(client, result.currentSettings);
				if (!conflictIsStale(result.actualRevision)) dispatch({
					type: "command-conflict",
					conflict: result,
					message: "Connection Settings changed while models were refreshing. Your draft is preserved.",
				});
				return;
			}
			if (result.outcome !== "available") {
				dispatch({
				type: "refresh-failed",
				message: result.outcome === "invalid" || result.outcome === "unusable" ? result.reason
					: result.outcome === "not-found" ? PROFILE_NOT_FOUND_ERROR : "Model catalog refresh could not be completed.",
			});
				return;
			}
			if (result.value.outcome === "success") {
				const refreshed = result.value.profile;
				const settingsRevision = result.value.settingsRevision;
				void client.cancelQueries({ queryKey: settingsKey });
				client.setQueryData<ConnectionSettings>(settingsKey, (current) => current === undefined || settingsRevision < current.revision
					? current
					: { revision: settingsRevision, profiles: current.profiles.map((profile) => profile.id === refreshed.id ? refreshed : profile) });
				dispatch({ type: "refresh-succeeded", notice: `Model catalog refreshed. ${refreshed.discoveryCatalog.length} model IDs are available for autocomplete.` });
				return;
			}
			dispatch({ type: "refresh-failed", message: result.value.outcome === "failure" ? result.value.message : PROFILE_NOT_FOUND_ERROR });
		},
		onError: () => dispatch({ type: "refresh-failed", message: "Model catalog refresh could not be completed." }),
	});

	const setDraft = (value: ConnectionProfileDraft) => dispatch({ type: "set-draft", draft: value });
	const setCredentialDraft = (value: string) => dispatch({ type: "set-credential-draft", value });
	const setHeaderEditorData = (value: HeaderEditorData) => dispatch({ type: "set-header-editor-data", value });
	const setTestModelId = (value: string) => dispatch({ type: "set-test-model-id", value });
	const setPendingDeletionProfileId = (value: number | null) => dispatch({ type: "set-pending-deletion", value });

	const selectedProfile = settings?.profiles.find((profile) => profile.id === selectedProfileId);
	const pendingDeletionProfile = settings?.profiles.find((profile) => profile.id === pendingDeletionProfileId);
	const refreshModelsDisabledReason = selectedProfileId === null
		? "Save this connection before refreshing."
		: draft.modelsUrl.trim().length === 0
			? "Enter a Models URL before refreshing."
			: selectedProfile?.modelsUrl.trim() !== draft.modelsUrl.trim()
				? "Save the Models URL before refreshing."
				: refresh.isPending
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
	const dirty = editorOpen && (selectedProfile === undefined
		|| JSON.stringify(draft) !== JSON.stringify(copyDraft(selectedProfile))
		|| JSON.stringify(headerEditorData) !== JSON.stringify(headerEditorDataFor(selectedProfile.headers))
		|| credentialDraft.length > 0);

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
		dispatch({ type: "test-started" });
		const request: TestConnectionDraftInput = {
			profile: draft,
			modelId: testModelId,
			headers: headerOperationsFor(headerEditorData),
		};
		if (selectedProfileId !== null) request.profileId = selectedProfileId;
		test.mutate(request);
	};

	const refreshModels = async () => {
		if (selectedProfileId === null) { dispatch({ type: "set-error", message: "Save this connection before refreshing its Models URL." }); return; }
		if (draft.modelsUrl.trim().length === 0) { dispatch({ type: "set-error", message: "Refresh requires an exact Models URL." }); return; }
		if (selectedProfile?.modelsUrl.trim() !== draft.modelsUrl.trim()) { dispatch({ type: "set-error", message: "Save the Models URL change before refreshing the catalog." }); return; }
		dispatch({ type: "refresh-started" });
		refresh.mutate(selectedProfileId);
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
		const commandPayload: ConnectionSettingsCommand = selectedProfileId === null
			? { type: "create-profile", expectedRevision: settings.revision, profile: draft, credential: credentialDraft.length > 0 ? credentialDraft : null, headers }
			: { type: "apply-profile", expectedRevision: settings.revision, profileId: selectedProfileId, profile: draft, headers };
		if (credentialDraft.length > 0) commandPayload.credential = credentialDraft;
		const result = await command.mutateAsync({
			type: "apply",
			command: commandPayload,
			draftDisplayName: draft.displayName,
			submitted: { selectedProfileId, editorIdentity: state.editorIdentity },
		});
		return result.outcome === "available";
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
		await command.mutateAsync({
			type: "delete",
			command: { type: "delete-profile", expectedRevision: settings.revision, profileId: pendingDeletionProfile.id },
			deletedDisplayName: pendingDeletionProfile.displayName,
		});
	};

	const resetCredential = async () => {
		if (settings === null || selectedProfileId === null) return;
		dispatch({ type: "clear-feedback" });
		await command.mutateAsync({
			type: "reset-credential",
			command: { type: "reset-credential", expectedRevision: settings.revision, profileId: selectedProfileId, confirmed: true },
		});
	};

	return {
		settings,
		presets,
		loading: settingsQuery.isPending || presetsQuery.isPending,
		selectedProfileId,
		draft,
		credentialDraft,
		headerEditorData,
		testModelId,
		testResult,
		testPending: test.isPending,
		discoveryPending: refresh.isPending,
		pendingDeletionProfileId,
		editorOpen,
		canSave,
		dirty,
		saving: command.isPending,
		validationError,
		conflict,
		notice,
		error: error ?? loadError,
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
