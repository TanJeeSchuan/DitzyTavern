import { useMemo, useState } from "react";
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
	copyDraft,
	preserveConnectionDraftOnConflict,
	type ConnectionSettingsConflict,
} from "../../connection-settings-state";
import { useAsyncEffect } from "../../lib/use-async";
import { resolveChatCompletionsRequestUrl } from "../../../shared/connection-url";

export const emptyDraft: ConnectionProfileDraft = {
	displayName: "",
	apiFormat: "chat-completions",
	requestUrl: "",
	modelsUrl: "",
	modelBackend: "automatic",
	adapter: "openai-compatible",
	outputTokenRepresentation: "automatic",
	timeoutMs: 120000,
	pinnedModels: [],
};

export type HeaderEditorValue = {
	configured: boolean;
	operation: "keep" | "replace" | "remove";
	replacement: string;
};
export interface HeaderEditorData {
	[name: string]: HeaderEditorValue;
}
interface HeaderEditorInput {
	configured?: unknown;
	operation?: unknown;
	replacement?: unknown;
}

export const headerEditorDataFor = (headers: ConnectionProfile["headers"]): HeaderEditorData => {
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
	// Catalog slice: the server-owned Connection Settings and Presets, plus
	// the initial load flag.
	const [settings, setSettings] = useState<ConnectionSettings | null>(null);
	const [presets, setPresets] = useState<ConnectionPreset[]>([]);
	const [loading, setLoading] = useState(true);

	// Editor-draft slice: the editable Profile draft and its credential,
	// header, and test-model companions.
	const [draft, setDraft] = useState<ConnectionProfileDraft>(emptyDraft);
	const [credentialDraft, setCredentialDraft] = useState("");
	const [headerEditorData, setHeaderEditorData] = useState<HeaderEditorData>({});
	const [testModelId, setTestModelId] = useState("");
	const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
	const [headersExpanded, setHeadersExpanded] = useState(false);

	// Selection slice: which Profile is open, pending deletion, or offered as
	// a replacement, plus the menu visibility flags.
	const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
	const [replacementProfileId, setReplacementProfileId] = useState<number | null>(null);
	const [pendingDeletionProfileId, setPendingDeletionProfileId] = useState<number | null>(null);
	const [openProfileMenuId, setOpenProfileMenuId] = useState<number | null>(null);
	const [presetChoicesOpen, setPresetChoicesOpen] = useState(false);

	// Feedback slice: transient command outcomes surfaced to the user.
	const [conflict, setConflict] = useState<ConnectionSettingsConflict | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [testPending, setTestPending] = useState(false);
	const [discoveryPending, setDiscoveryPending] = useState(false);

	useAsyncEffect((isCancelled) => {
		void Promise.all([loadConnectionSettings(), loadConnectionPresets()])
			.then(([loadedSettings, loadedPresets]) => {
				if (isCancelled()) return;
				const active = loadedSettings.profiles.find((profile) => profile.id === loadedSettings.activeProfileId);
				setSettings(loadedSettings);
				setPresets(loadedPresets);
				if (active) {
					setSelectedProfileId(active.id);
					setDraft(copyDraft(active));
					setHeaderEditorData(headerEditorDataFor(active.headers));
					setHeadersExpanded(active.headers.length > 0);
					setTestModelId(active.pinnedModels[0] ?? "");
					setReplacementProfileId(loadedSettings.profiles.find((profile) => profile.id !== active.id)?.id ?? null);
				}
			})
			.catch(() => {
				if (!isCancelled()) setError("Connection Settings could not be loaded.");
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

	const preserveConflict = (result: ConnectionSettingsResult): boolean => {
		if (!settings || result.outcome !== "conflict") return false;
		const preserved = preserveConnectionDraftOnConflict({
			settings,
			selectedProfileId,
			draft,
			credentialDraft,
			conflict: null,
		}, result);
		setSettings(preserved.settings);
		setDraft(preserved.draft);
		setCredentialDraft(preserved.credentialDraft);
		setConflict(preserved.conflict);
		return true;
	};

	// Runs one Connection Settings command and owns the failure wording
	// repeated by every Profile command handler: a conflict preserves the
	// editor state via preserveConflict, an invalid outcome surfaces the
	// server reason, and anything else reads as a missing Profile. Returns
	// the applied result, or null after the error slice is set.
	const runConnectionCommand = async (
		command: () => Promise<ConnectionSettingsResult>,
		conflictError: string,
	): Promise<AppliedConnectionSettings | null> => {
		const result = await command();
		if (result.outcome === "applied") return result;
		preserveConflict(result);
		setError(
			result.outcome === "conflict"
				? conflictError
				: result.outcome === "invalid"
					? result.reason
					: PROFILE_NOT_FOUND_ERROR,
		);
		return null;
	};

	const choosePreset = (preset: ConnectionPreset) => {
		setSelectedProfileId(null);
		setDraft(copyDraft(preset.profile));
		setCredentialDraft("");
		setHeaderEditorData({});
		setTestModelId(preset.profile.pinnedModels[0] ?? "");
		setTestResult(null);
		setReplacementProfileId(null);
		setPendingDeletionProfileId(null);
		setOpenProfileMenuId(null);
		setPresetChoicesOpen(false);
		setHeadersExpanded(false);
		setConflict(null);
		setNotice(`${preset.label} defaults copied into a new editable Profile draft.`);
		setError(null);
	};

	const chooseProfile = (profile: ConnectionProfile) => {
		setSelectedProfileId(profile.id);
		setDraft(copyDraft(profile));
		setCredentialDraft("");
		setHeaderEditorData(headerEditorDataFor(profile.headers));
		setTestModelId(profile.pinnedModels[0] ?? "");
		setTestResult(null);
		setReplacementProfileId(settings?.profiles.find((entry) => entry.id !== profile.id)?.id ?? null);
		setPendingDeletionProfileId(null);
		setOpenProfileMenuId(null);
		setPresetChoicesOpen(false);
		setHeadersExpanded(profile.headers.length > 0);
		setConflict(null);
		setNotice(null);
		setError(null);
	};

	const testDraft = async () => {
		if (testModelId.trim().length === 0) {
			setError("Enter a model ID before testing this Connection Profile.");
			return;
		}
		setTestPending(true);
		setTestResult(null);
		setNotice(null);
		setError(null);
		try {
			const request: TestConnectionDraftInput = {
				profile: draft,
				modelId: testModelId,
				headers: headerOperationsFor(headerEditorData),
			};
			if (selectedProfileId !== null) request.profileId = selectedProfileId;
			const result = await testConnectionDraft(request);
			setTestResult(result);
			if (result.outcome === "success") setNotice(result.message);
			else setError(result.outcome === "failure" ? result.message : result.reason);
		} catch {
			setError("Test Connection could not be completed.");
		} finally {
			setTestPending(false);
		}
	};

	const refreshModels = async () => {
		if (selectedProfileId === null) { setError("Save this connection before refreshing its Models URL."); return; }
		if (draft.modelsUrl.trim().length === 0) { setError("Refresh requires an exact Models URL."); return; }
		if (selectedProfile?.modelsUrl.trim() !== draft.modelsUrl.trim()) { setError("Save the Models URL change before refreshing the catalog."); return; }
		setDiscoveryPending(true);
		setNotice(null);
		setError(null);
		try {
			const result = await refreshDiscoveryCatalog(selectedProfileId);
			if (result.outcome === "success") {
				setSettings(settings === null ? null : {
					...settings,
					profiles: settings.profiles.map((profile) => profile.id === result.profile.id ? result.profile : profile),
				});
				setNotice(`Model catalog refreshed. ${result.profile.discoveryCatalog.length} model IDs are available for autocomplete.`);
			} else if (result.outcome === "failure") setError(result.message);
			else if (result.outcome === "invalid") setError(result.reason);
			else if (result.outcome === "conflict") {
				preserveConflict(result);
				setError("Connection Settings changed while models were refreshing. Your draft is preserved.");
			}
			else setError(PROFILE_NOT_FOUND_ERROR);
		} catch { setError("Model catalog refresh could not be completed."); }
		finally { setDiscoveryPending(false); }
	};

	const applyDraft = async () => {
		if (settings === null) return;
		setNotice(null);
		setError(null);
		let headers: ConnectionHeaderOperation[];
		try { headers = headerOperationsFor(headerEditorData); }
		catch { setError("Custom header drafts are invalid."); return; }
		const command: ConnectionSettingsCommand = selectedProfileId === null
			? { type: "create-profile", expectedRevision: settings.revision, profile: draft, credential: credentialDraft.length > 0 ? credentialDraft : null, headers }
			: { type: "apply-profile", expectedRevision: settings.revision, profileId: selectedProfileId, profile: draft, headers };
		const applied = await runConnectionCommand(
			() => saveConnectionCommand(command),
			APPLY_CONFLICT_ERROR,
		);
		if (applied === null) return;
		const saved = applied.settings.profiles.find((profile) =>
			(selectedProfileId !== null && profile.id === selectedProfileId) ||
			(selectedProfileId === null && profile.displayName === draft.displayName.trim().replace(/\s+/g, " ")),
		);
		setSettings(applied.settings);
		setConflict(null);
		setTestResult(null);
		setNotice(selectedProfileId !== null && credentialDraft.length > 0 ? "Profile changes saved. The credential draft is still unsaved." : "Changes saved. No provider request was made.");
		if (saved) {
			setSelectedProfileId(saved.id);
			setDraft(copyDraft(saved));
			setHeaderEditorData(headerEditorDataFor(saved.headers));
		}
		if (selectedProfileId === null) setCredentialDraft("");
	};

	const updateCredential = async () => {
		if (settings === null || selectedProfileId === null || credentialDraft.length === 0) return;
		setNotice(null);
		setError(null);
		const applied = await runConnectionCommand(
			() => saveConnectionCommand({ type: "set-credential", expectedRevision: settings.revision, profileId: selectedProfileId, credential: credentialDraft }),
			CREDENTIAL_CONFLICT_ERROR,
		);
		if (applied === null) return;
		setSettings(applied.settings);
		setCredentialDraft("");
		setConflict(null);
		setNotice("Credential updated.");
	};

	const activateSelectedProfile = async () => {
		if (settings === null || selectedProfileId === null || selectedProfileId === settings.activeProfileId) return;
		setNotice(null);
		setError(null);
		const applied = await runConnectionCommand(
			() => saveConnectionCommand({ type: "activate-profile", expectedRevision: settings.revision, profileId: selectedProfileId }),
			APPLY_CONFLICT_ERROR,
		);
		if (applied === null) return;
		setSettings(applied.settings);
		setConflict(null);
		setNotice("Connection set as active for new generations.");
	};

	const requestProfileDeletion = (profile: ConnectionProfile) => {
		setPendingDeletionProfileId(profile.id);
		setReplacementProfileId(profile.id === settings?.activeProfileId ? settings.profiles.find((entry) => entry.id !== profile.id)?.id ?? null : null);
		setOpenProfileMenuId(null);
		setNotice(null);
		setError(null);
	};

	const deletePendingProfile = async () => {
		if (settings === null || pendingDeletionProfileId === null || !pendingDeletionProfile) return;
		const deletingActive = pendingDeletionProfile.id === settings.activeProfileId;
		const replacement = deletingActive && settings.profiles.length > 1 ? replacementProfileId : null;
		if (deletingActive && settings.profiles.length > 1 && replacement === null) { setError("Choose a replacement Profile before deleting the active Profile."); return; }
		setNotice(null);
		setError(null);
		const applied = await runConnectionCommand(
			() => saveConnectionCommand({ type: "delete-profile", expectedRevision: settings.revision, profileId: pendingDeletionProfile.id, replacementProfileId: replacement }),
			APPLY_CONFLICT_ERROR,
		);
		if (applied === null) return;
		const nextProfile = applied.settings.profiles.find((profile) => profile.id === (replacement ?? applied.settings.activeProfileId));
		setSettings(applied.settings);
		setConflict(null);
		setPendingDeletionProfileId(null);
		setCredentialDraft("");
		setNotice(`${pendingDeletionProfile.displayName} deleted.`);
		if (nextProfile) {
			setSelectedProfileId(nextProfile.id);
			setDraft(copyDraft(nextProfile));
			setHeaderEditorData(headerEditorDataFor(nextProfile.headers));
			setReplacementProfileId(applied.settings.profiles.find((profile) => profile.id !== nextProfile.id)?.id ?? null);
		} else {
			setSelectedProfileId(null);
			setDraft(copyDraft(emptyDraft));
			setHeaderEditorData({});
			setReplacementProfileId(null);
		}
	};

	const resetCredential = async () => {
		if (settings === null || selectedProfileId === null || !window.confirm("Reset this credential? This cannot be undone.")) return;
		setNotice(null);
		setError(null);
		const result = await saveConnectionCommand({ type: "reset-credential", expectedRevision: settings.revision, profileId: selectedProfileId, confirmed: true });
		// Reset deliberately skips preserveConflict: the credential draft is
		// cleared either way, so a conflict reads as a plain failure here.
		if (result.outcome !== "applied") { setError(result.outcome === "invalid" ? result.reason : "Credential reset failed."); return; }
		setSettings(result.settings);
		setConflict(null);
		setNotice("Credential reset.");
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
