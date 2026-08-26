import { useEffect, useMemo, useReducer } from "react";
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

type ControllerState = {
	settings: ConnectionSettings | null;
	presets: ConnectionPreset[];
	draft: ConnectionProfileDraft;
	selectedProfileId: number | null;
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
	loading: boolean;
};

const initialState: ControllerState = {
	settings: null,
	presets: [],
	draft: emptyDraft,
	selectedProfileId: null,
	credentialDraft: "",
	headerEditorData: {},
	testModelId: "",
	testResult: null,
	testPending: false,
	discoveryPending: false,
	replacementProfileId: null,
	pendingDeletionProfileId: null,
	openProfileMenuId: null,
	presetChoicesOpen: false,
	headersExpanded: false,
	conflict: null,
	notice: null,
	error: null,
	loading: true,
};

type Action = { type: "patch"; patch: Partial<ControllerState> };

function reducer(state: ControllerState, action: Action): ControllerState {
	return action.type === "patch" ? { ...state, ...action.patch } : state;
}

export type ConnectionSettingsController = ControllerState & {
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

export function useConnectionSettingsController(): ConnectionSettingsController {
	const [state, dispatch] = useReducer(reducer, initialState);
	const patch = (next: Partial<ControllerState>) => dispatch({ type: "patch", patch: next });

	useEffect(() => {
		let cancelled = false;
		void Promise.all([loadConnectionSettings(), loadConnectionPresets()])
			.then(([settings, presets]) => {
				if (cancelled) return;
				const active = settings.profiles.find((profile) => profile.id === settings.activeProfileId);
				const loaded: Partial<ControllerState> = { settings, presets };
				if (active) {
					Object.assign(loaded, {
						selectedProfileId: active.id,
						draft: copyDraft(active),
						headerEditorData: headerEditorDataFor(active.headers),
						headersExpanded: active.headers.length > 0,
						testModelId: active.pinnedModels[0] ?? "",
						replacementProfileId: settings.profiles.find((profile) => profile.id !== active.id)?.id ?? null,
					});
				}
				patch(loaded);
			})
			.catch(() => {
				if (!cancelled) patch({ error: "Connection Settings could not be loaded." });
			})
			.finally(() => {
				if (!cancelled) patch({ loading: false });
			});
		return () => { cancelled = true; };
	}, []);

	const selectedProfile = state.settings?.profiles.find((profile) => profile.id === state.selectedProfileId);
	const pendingDeletionProfile = state.settings?.profiles.find((profile) => profile.id === state.pendingDeletionProfileId);
	const refreshModelsDisabledReason = state.selectedProfileId === null
		? "Save this connection before refreshing."
		: state.draft.modelsUrl.trim().length === 0
			? "Enter a Models URL before refreshing."
			: selectedProfile?.modelsUrl.trim() !== state.draft.modelsUrl.trim()
				? "Save the Models URL before refreshing."
				: state.discoveryPending
					? "A model refresh is already in progress."
					: undefined;
	const resolvedRequestUrl = useMemo(() => {
		if (state.draft.requestUrl.trim().length === 0) return "Not configured";
		try {
			return resolveChatCompletionsRequestUrl(state.draft.requestUrl);
		} catch (error) {
			return error instanceof Error ? `Invalid: ${error.message}` : "Invalid request URL";
		}
	}, [state.draft.requestUrl]);

	const preserveConflict = (result: ConnectionSettingsResult): boolean => {
		if (!state.settings || result.outcome !== "conflict") return false;
		const preserved = preserveConnectionDraftOnConflict({
			settings: state.settings,
			selectedProfileId: state.selectedProfileId,
			draft: state.draft,
			credentialDraft: state.credentialDraft,
			conflict: null,
		}, result);
		patch({
			settings: preserved.settings,
			draft: preserved.draft,
			credentialDraft: preserved.credentialDraft,
			conflict: preserved.conflict,
		});
		return true;
	};

	const choosePreset = (preset: ConnectionPreset) => patch({
		selectedProfileId: null,
		draft: copyDraft(preset.profile),
		credentialDraft: "",
		headerEditorData: {},
		testModelId: preset.profile.pinnedModels[0] ?? "",
		testResult: null,
		replacementProfileId: null,
		pendingDeletionProfileId: null,
		openProfileMenuId: null,
		presetChoicesOpen: false,
		headersExpanded: false,
		conflict: null,
		notice: `${preset.label} defaults copied into a new editable Profile draft.`,
		error: null,
	});

	const chooseProfile = (profile: ConnectionProfile) => patch({
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
		headersExpanded: profile.headers.length > 0,
		conflict: null,
		notice: null,
		error: null,
	});

	const testDraft = async () => {
		if (state.testModelId.trim().length === 0) {
			patch({ error: "Enter a model ID before testing this Connection Profile." });
			return;
		}
		patch({ testPending: true, testResult: null, notice: null, error: null });
		try {
			const request: TestConnectionDraftInput = {
				profile: state.draft,
				modelId: state.testModelId,
				headers: headerOperationsFor(state.headerEditorData),
			};
			if (state.selectedProfileId !== null) request.profileId = state.selectedProfileId;
			const result = await testConnectionDraft(request);
			patch({ testResult: result, ...(result.outcome === "success" ? { notice: result.message } : { error: result.outcome === "failure" ? result.message : result.reason }) });
		} catch {
			patch({ error: "Test Connection could not be completed." });
		} finally {
			patch({ testPending: false });
		}
	};

	const refreshModels = async () => {
		if (state.selectedProfileId === null) { patch({ error: "Save this connection before refreshing its Models URL." }); return; }
		if (state.draft.modelsUrl.trim().length === 0) { patch({ error: "Refresh requires an exact Models URL." }); return; }
		if (selectedProfile?.modelsUrl.trim() !== state.draft.modelsUrl.trim()) { patch({ error: "Save the Models URL change before refreshing the catalog." }); return; }
		patch({ discoveryPending: true, notice: null, error: null });
		try {
			const result = await refreshDiscoveryCatalog(state.selectedProfileId);
			if (result.outcome === "success") {
				patch({
					settings: state.settings === null ? null : {
						...state.settings,
						profiles: state.settings.profiles.map((profile) => profile.id === result.profile.id ? result.profile : profile),
					},
					notice: `Model catalog refreshed. ${result.profile.discoveryCatalog.length} model IDs are available for autocomplete.`,
				});
			} else if (result.outcome === "failure") patch({ error: result.message });
			else if (result.outcome === "invalid") patch({ error: result.reason });
			else if (result.outcome === "conflict") {
				preserveConflict(result);
				patch({ error: "Connection Settings changed while models were refreshing. Your draft is preserved." });
			}
			else patch({ error: "The selected Profile no longer exists." });
		} catch { patch({ error: "Model catalog refresh could not be completed." }); }
		finally { patch({ discoveryPending: false }); }
	};

	const applyDraft = async () => {
		if (!state.settings) return;
		patch({ notice: null, error: null });
		let headers: ConnectionHeaderOperation[];
		try { headers = headerOperationsFor(state.headerEditorData); }
		catch { patch({ error: "Custom header drafts are invalid." }); return; }
		const command: ConnectionSettingsCommand = state.selectedProfileId === null
			? { type: "create-profile", expectedRevision: state.settings.revision, profile: state.draft, credential: state.credentialDraft.length > 0 ? state.credentialDraft : null, headers }
			: { type: "apply-profile", expectedRevision: state.settings.revision, profileId: state.selectedProfileId, profile: state.draft, headers };
		const result = await saveConnectionCommand(command);
		if (result.outcome !== "applied") {
			preserveConflict(result);
			patch({ error: result.outcome === "conflict" ? "These settings changed elsewhere. Your unsaved draft is preserved." : result.outcome === "invalid" ? result.reason : "The selected Profile no longer exists." });
			return;
		}
		const saved = result.settings.profiles.find((profile) =>
			(state.selectedProfileId !== null && profile.id === state.selectedProfileId) ||
			(state.selectedProfileId === null && profile.displayName === state.draft.displayName.trim().replace(/\s+/g, " ")),
		);
		const applied: Partial<ControllerState> = {
			settings: result.settings,
			conflict: null,
			testResult: null,
			notice: state.selectedProfileId !== null && state.credentialDraft.length > 0 ? "Profile changes saved. The credential draft is still unsaved." : "Changes saved. No provider request was made.",
		};
		if (saved) {
			applied.selectedProfileId = saved.id;
			applied.draft = copyDraft(saved);
			applied.headerEditorData = headerEditorDataFor(saved.headers);
		}
		if (state.selectedProfileId === null) applied.credentialDraft = "";
		patch(applied);
	};

	const updateCredential = async () => {
		if (!state.settings || state.selectedProfileId === null || state.credentialDraft.length === 0) return;
		patch({ notice: null, error: null });
		const result = await saveConnectionCommand({ type: "set-credential", expectedRevision: state.settings.revision, profileId: state.selectedProfileId, credential: state.credentialDraft });
		if (result.outcome !== "applied") {
			preserveConflict(result);
			patch({ error: result.outcome === "conflict" ? "These settings changed elsewhere. Your credential draft is preserved." : result.outcome === "invalid" ? result.reason : "The selected Profile no longer exists." });
			return;
		}
		patch({ settings: result.settings, credentialDraft: "", conflict: null, notice: "Credential updated." });
	};

	const activateSelectedProfile = async () => {
		if (!state.settings || state.selectedProfileId === null || state.selectedProfileId === state.settings.activeProfileId) return;
		patch({ notice: null, error: null });
		const result = await saveConnectionCommand({ type: "activate-profile", expectedRevision: state.settings.revision, profileId: state.selectedProfileId });
		if (result.outcome !== "applied") {
			preserveConflict(result);
			patch({ error: result.outcome === "conflict" ? "These settings changed elsewhere. Your unsaved draft is preserved." : result.outcome === "not-found" ? "The selected Profile no longer exists." : result.reason });
			return;
		}
		patch({ settings: result.settings, conflict: null, notice: "Connection set as active for new generations." });
	};

	const requestProfileDeletion = (profile: ConnectionProfile) => patch({
		pendingDeletionProfileId: profile.id,
		replacementProfileId: profile.id === state.settings?.activeProfileId ? state.settings.profiles.find((entry) => entry.id !== profile.id)?.id ?? null : null,
		openProfileMenuId: null,
		notice: null,
		error: null,
	});

	const deletePendingProfile = async () => {
		if (!state.settings || state.pendingDeletionProfileId === null || !pendingDeletionProfile) return;
		const deletingActive = pendingDeletionProfile.id === state.settings.activeProfileId;
		const replacement = deletingActive && state.settings.profiles.length > 1 ? state.replacementProfileId : null;
		if (deletingActive && state.settings.profiles.length > 1 && replacement === null) { patch({ error: "Choose a replacement Profile before deleting the active Profile." }); return; }
		patch({ notice: null, error: null });
		const result = await saveConnectionCommand({ type: "delete-profile", expectedRevision: state.settings.revision, profileId: pendingDeletionProfile.id, replacementProfileId: replacement });
		if (result.outcome !== "applied") {
			preserveConflict(result);
			patch({ error: result.outcome === "conflict" ? "These settings changed elsewhere. Your unsaved draft is preserved." : result.outcome === "invalid" ? result.reason : "The selected Profile no longer exists." });
			return;
		}
		const nextProfile = result.settings.profiles.find((profile) => profile.id === (replacement ?? result.settings.activeProfileId));
		patch({
			settings: result.settings,
			conflict: null,
			pendingDeletionProfileId: null,
			credentialDraft: "",
			notice: `${pendingDeletionProfile.displayName} deleted.`,
			...(nextProfile ? { selectedProfileId: nextProfile.id, draft: copyDraft(nextProfile), headerEditorData: headerEditorDataFor(nextProfile.headers), replacementProfileId: result.settings.profiles.find((profile) => profile.id !== nextProfile.id)?.id ?? null } : { selectedProfileId: null, draft: copyDraft(emptyDraft), headerEditorData: {}, replacementProfileId: null }),
		});
	};

	const resetCredential = async () => {
		if (!state.settings || state.selectedProfileId === null || !window.confirm("Reset this credential? This cannot be undone.")) return;
		patch({ notice: null, error: null });
		const result = await saveConnectionCommand({ type: "reset-credential", expectedRevision: state.settings.revision, profileId: state.selectedProfileId, confirmed: true });
		if (result.outcome !== "applied") { patch({ error: result.outcome === "invalid" ? result.reason : "Credential reset failed." }); return; }
		patch({ settings: result.settings, conflict: null, notice: "Credential reset." });
	};

	return {
		...state,
		selectedProfile,
		pendingDeletionProfile,
		refreshModelsDisabledReason,
		resolvedRequestUrl,
		choosePreset,
		chooseProfile,
		setDraft: (draft) => patch({ draft }),
		setCredentialDraft: (credentialDraft) => patch({ credentialDraft }),
		setHeaderEditorData: (headerEditorData) => patch({ headerEditorData }),
		setTestModelId: (testModelId) => patch({ testModelId }),
		setHeadersExpanded: (headersExpanded) => patch({ headersExpanded }),
		setPresetChoicesOpen: (presetChoicesOpen) => patch({ presetChoicesOpen }),
		setOpenProfileMenuId: (openProfileMenuId) => patch({ openProfileMenuId }),
		setReplacementProfileId: (replacementProfileId) => patch({ replacementProfileId }),
		setPendingDeletionProfileId: (pendingDeletionProfileId) => patch({ pendingDeletionProfileId }),
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
