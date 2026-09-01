import { useMemo, useReducer, useState } from "react";
import { JsonData } from "json-edit-react";
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
	type HeaderEditorValue,
} from "../../connection-settings-state";
import { useAsyncEffect } from "../../lib/use-async";
import { resolveChatCompletionsRequestUrl } from "../../../shared/connection-url";

interface HeaderEditorInput {
	configured?: unknown;
	operation?: unknown;
	replacement?: unknown;
}

export function parseHeaderEditorData(value: JsonData): HeaderEditorData {
	if (Object.prototype.toString.call(value) !== "[object Object]") return {};
	// SAFETY: the object-tag check above establishes an object accepted by Object.entries.
	const entries = Object.entries(value as object).flatMap(([name, candidate]) => {
		if (Object.prototype.toString.call(candidate) !== "[object Object]") return [];
		// SAFETY: the object-tag check above establishes the JSON editor node shape.
		const record = candidate as HeaderEditorInput;
		const operation = record.operation;
		const replacement = record.replacement;
		return [[name, {
			configured: record.configured === true,
			operation: operation === "replace" || operation === "remove" ? operation : "keep",
			replacement: Object.prototype.toString.call(replacement) === "[object String]"
				? String(replacement)
				: "",
		} satisfies HeaderEditorValue] as const];
	});
	return Object.fromEntries(entries);
}

export function headerOperationsFor(data: HeaderEditorData): ConnectionHeaderOperation[] {
	return Object.entries(data).map(([name, value]) => {
		if (value.operation === "replace") return { name, operation: "replace", value: value.replacement };
		if (value.operation === "remove") return { name, operation: "remove" };
		return { name, operation: "keep" };
	});
}

// The command-failure wording shared by every Profile command handler; the
// conflict variant is passed per command because it names what was preserved.
const APPLY_CONFLICT_ERROR = "These settings changed elsewhere. Your unsaved draft is preserved.";
const CREDENTIAL_CONFLICT_ERROR = "These settings changed elsewhere. Your credential draft is preserved.";
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
	replacementProfileId: number | null;
	pendingDeletionProfileId: number | null;
	openProfileMenuId: number | null;
	presetChoicesOpen: boolean;
	headersExpanded: boolean;
	conflict: ConnectionSettingsConflict | null;
	notice: string | null;
	error: string | null;
	selectedProfile: ConnectionProfile | undefined;
	pendingDeletionProfile: ConnectionProfile | undefined;
	refreshModelsDisabledReason: string | undefined;
	resolvedRequestUrl: string;
	choosePreset: (preset: ConnectionPreset) => void;
	chooseProfile: (profile: ConnectionProfile) => void;
	setDraft: (draft: ConnectionProfileDraft) => void;
	setCredentialDraft: (value: string) => void;
	setHeaderEditorData: (value: HeaderEditorData) => void;
	setTestModelId: (value: string) => void;
	setHeadersExpanded: (value: boolean) => void;
	setPresetChoicesOpen: (value: boolean) => void;
	setOpenProfileMenuId: (value: number | null) => void;
	setReplacementProfileId: (value: number | null) => void;
	setPendingDeletionProfileId: (value: number | null) => void;
	testDraft: () => Promise<void>;
	refreshModels: () => Promise<void>;
	applyDraft: () => Promise<void>;
	updateCredential: () => Promise<void>;
	activateSelectedProfile: () => Promise<void>;
	requestProfileDeletion: (profile: ConnectionProfile) => void;
	deletePendingProfile: () => Promise<void>;
	resetCredential: () => Promise<void>;
};

/**
 * Owns the Connection Settings editor state. The former single patch-any-field
 * store is split into focused slices — server catalog, editable Profile
 * draft, selection and menus, and user-facing feedback — and the Profile
 * command handlers share one runConnectionCommand failure path. The returned
 * controller shape is unchanged for its callers.
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
		replacementProfileId,
		pendingDeletionProfileId,
		openProfileMenuId,
		presetChoicesOpen,
		headersExpanded,
		conflict,
		notice,
		error,
	} = state;
	const [loading, setLoading] = useState(true);
	const [testPending, setTestPending] = useState(false);
	const [discoveryPending, setDiscoveryPending] = useState(false);

	const setDraft = (value: ConnectionProfileDraft) => dispatch({ type: "set-draft", draft: value });
	const setCredentialDraft = (value: string) => dispatch({ type: "set-credential-draft", value });
	const setHeaderEditorData = (value: HeaderEditorData) => dispatch({ type: "set-header-editor-data", value });
	const setTestModelId = (value: string) => dispatch({ type: "set-test-model-id", value });
	const setHeadersExpanded = (value: boolean) => dispatch({ type: "set-headers-expanded", value });
	const setPresetChoicesOpen = (value: boolean) => dispatch({ type: "set-preset-choices-open", value });
	const setOpenProfileMenuId = (value: number | null) => dispatch({ type: "set-open-profile-menu", value });
	const setReplacementProfileId = (value: number | null) => dispatch({ type: "set-replacement-profile", value });
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
		if (draft.requestUrl.trim().length === 0) return "Not configured";
		try {
			return resolveChatCompletionsRequestUrl(draft.requestUrl);
		} catch (error) {
			return error instanceof Error ? `Invalid: ${error.message}` : "Invalid request URL";
		}
	}, [draft.requestUrl]);

	// Runs one Connection Settings command and owns the failure wording
	// repeated by every Profile command handler: a conflict preserves the
	// editor state in the reducer, an invalid outcome surfaces the
	// server reason, and anything else reads as a missing Profile. Returns
	// the applied result, or null after the error slice is set.
	const runConnectionCommand = async (
		command: () => Promise<ConnectionSettingsResult>,
		conflictError: string,
	): Promise<AppliedConnectionSettings | null> => {
		const result = await command();
		if (result.outcome === "applied") return result;
		if (result.outcome === "conflict") {
			dispatch({ type: "command-conflict", conflict: result, message: conflictError });
		} else {
			dispatch({
				type: "set-error",
				message: result.outcome === "invalid" ? result.reason : PROFILE_NOT_FOUND_ERROR,
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

	const testDraft = async () => {
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
		if (settings === null) return;
		let headers: ConnectionHeaderOperation[];
		try { headers = headerOperationsFor(headerEditorData); }
		catch { dispatch({ type: "set-error", message: "Custom header drafts are invalid." }); return; }
		dispatch({ type: "clear-feedback" });
		const appliedProfileId = selectedProfileId;
		const appliedDraftDisplayName = draft.displayName;
		const credentialWasProvided = credentialDraft.length > 0;
		const command: ConnectionSettingsCommand = selectedProfileId === null
			? { type: "create-profile", expectedRevision: settings.revision, profile: draft, credential: credentialDraft.length > 0 ? credentialDraft : null, headers }
			: { type: "apply-profile", expectedRevision: settings.revision, profileId: selectedProfileId, profile: draft, headers };
		const applied = await runConnectionCommand(
			() => saveConnectionCommand(command),
			APPLY_CONFLICT_ERROR,
		);
		if (applied === null) return;
		dispatch({
			type: "apply-succeeded",
			settings: applied.settings,
			selectedProfileId: appliedProfileId,
			draftDisplayName: appliedDraftDisplayName,
			credentialWasProvided,
		});
	};

	const updateCredential = async () => {
		if (settings === null || selectedProfileId === null || credentialDraft.length === 0) return;
		dispatch({ type: "clear-feedback" });
		const applied = await runConnectionCommand(
			() => saveConnectionCommand({ type: "set-credential", expectedRevision: settings.revision, profileId: selectedProfileId, credential: credentialDraft }),
			CREDENTIAL_CONFLICT_ERROR,
		);
		if (applied === null) return;
		dispatch({ type: "credential-succeeded", settings: applied.settings });
	};

	const activateSelectedProfile = async () => {
		if (settings === null || selectedProfileId === null || selectedProfileId === settings.activeProfileId) return;
		dispatch({ type: "clear-feedback" });
		const applied = await runConnectionCommand(
			() => saveConnectionCommand({ type: "activate-profile", expectedRevision: settings.revision, profileId: selectedProfileId }),
			APPLY_CONFLICT_ERROR,
		);
		if (applied === null) return;
		dispatch({ type: "activate-succeeded", settings: applied.settings });
	};

	const requestProfileDeletion = (profile: ConnectionProfile) => {
		dispatch({
			type: "request-deletion",
			profileId: profile.id,
			replacementProfileId: profile.id === settings?.activeProfileId
				? settings.profiles.find((entry) => entry.id !== profile.id)?.id ?? null
				: null,
		});
	};

	const deletePendingProfile = async () => {
		if (settings === null || pendingDeletionProfileId === null || !pendingDeletionProfile) return;
		const deletingActive = pendingDeletionProfile.id === settings.activeProfileId;
		const replacement = deletingActive && settings.profiles.length > 1 ? replacementProfileId : null;
		if (deletingActive && settings.profiles.length > 1 && replacement === null) { dispatch({ type: "set-error", message: "Choose a replacement Profile before deleting the active Profile." }); return; }
		dispatch({ type: "clear-feedback" });
		const deletedDisplayName = pendingDeletionProfile.displayName;
		const applied = await runConnectionCommand(
			() => saveConnectionCommand({ type: "delete-profile", expectedRevision: settings.revision, profileId: pendingDeletionProfile.id, replacementProfileId: replacement }),
			APPLY_CONFLICT_ERROR,
		);
		if (applied === null) return;
		dispatch({
			type: "delete-succeeded",
			settings: applied.settings,
			deletedDisplayName,
			replacementProfileId: replacement,
		});
	};

	const resetCredential = async () => {
		if (settings === null || selectedProfileId === null || !window.confirm("Reset this credential? This cannot be undone.")) return;
		dispatch({ type: "clear-feedback" });
		let result: ConnectionSettingsResult;
		try {
			result = await saveConnectionCommand({ type: "reset-credential", expectedRevision: settings.revision, profileId: selectedProfileId, confirmed: true });
		} catch {
			dispatch({ type: "set-error", message: "Credential reset failed." });
			return;
		}
		// Reset deliberately skips preserveConflict: the credential draft is
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
		replacementProfileId,
		pendingDeletionProfileId,
		openProfileMenuId,
		presetChoicesOpen,
		headersExpanded,
		conflict,
		notice,
		error,
		selectedProfile,
		pendingDeletionProfile,
		refreshModelsDisabledReason,
		resolvedRequestUrl,
		choosePreset,
		chooseProfile,
		setDraft,
		setCredentialDraft,
		setHeaderEditorData,
		setTestModelId,
		setHeadersExpanded,
		setPresetChoicesOpen,
		setOpenProfileMenuId,
		setReplacementProfileId,
		setPendingDeletionProfileId,
		testDraft,
		refreshModels,
		applyDraft,
		updateCredential,
		activateSelectedProfile,
		requestProfileDeletion,
		deletePendingProfile,
		resetCredential,
	};
}
