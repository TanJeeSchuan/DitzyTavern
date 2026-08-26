import {
	Check,
	ChevronDown,
	Ellipsis,
	KeyRound,
	Plus,
	RotateCcw,
	Save,
	ShieldCheck,
	Trash2,
	Zap,
} from "lucide-react";
import { JsonEditor, type JsonData } from "json-edit-react";
import { useEffect, useMemo, useState } from "react";
import {
	loadConnectionPresets,
	loadConnectionSettings,
	refreshDiscoveryCatalog,
	saveConnectionCommand,
	testConnectionDraft,
	type ConnectionProfile,
	type ConnectionProfileDraft,
	type ConnectionHeaderOperation,
	type ConnectionPreset,
	type ConnectionSettings,
	type ConnectionSettingsResult,
	type TestConnectionDraftInput,
	type TestConnectionResult,
} from "../connection-settings";
import {
	preserveConnectionDraftOnConflict,
	type ConnectionSettingsConflict,
} from "../connection-settings-state";
import { resolveChatCompletionsRequestUrl } from "../../shared/connection-url";

const emptyDraft: ConnectionProfileDraft = {
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

const copyDraft = (profile: ConnectionProfileDraft): ConnectionProfileDraft => ({
	...profile,
	pinnedModels: [...profile.pinnedModels],
});

type HeaderEditorValue = {
	configured: boolean;
	operation: "keep" | "replace" | "remove";
	replacement: string;
};
type HeaderEditorData = Record<string, HeaderEditorValue>;
interface HeaderEditorInput {
	configured?: unknown;
	operation?: unknown;
	replacement?: unknown;
}

const headerEditorDataFor = (headers: ConnectionProfile["headers"]): HeaderEditorData =>
	// SAFETY: the projection is built from the server's redacted header shape;
	// it contains no stored header values.
	Object.fromEntries(headers.map((header) => [header.name, {
		configured: header.configured,
		operation: "keep" as const,
		replacement: "",
	}])) as HeaderEditorData;

function parseHeaderEditorData(value: JsonData) {
	if (Object.prototype.toString.call(value) !== "[object Object]") return {};
	// SAFETY: the object-tag check above establishes the JSON editor root as
	// an object before passing it to Object.entries.
	const entries = Object.entries(value as object).flatMap(([name, candidate]) => {
		if (Object.prototype.toString.call(candidate) !== "[object Object]") return [];
		// SAFETY: the object-tag check above establishes the JSON editor's object
		// node shape before reading the three known projection fields.
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

function headerOperationsFor(data: HeaderEditorData): ConnectionHeaderOperation[] {
	return Object.entries(data).map(([name, value]) => {
		if (value.operation === "replace") return { name, operation: "replace", value: value.replacement };
		if (value.operation === "remove") return { name, operation: "remove" };
		return { name, operation: "keep" };
	});
}

export function ConnectionSettingsPanel() {
	const [settings, setSettings] = useState<ConnectionSettings | null>(null);
	const [presets, setPresets] = useState<ConnectionPreset[]>([]);
	const [draft, setDraft] = useState<ConnectionProfileDraft>(emptyDraft);
	const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
	const [credentialDraft, setCredentialDraft] = useState("");
	const [headerEditorData, setHeaderEditorData] = useState<HeaderEditorData>({});
	const [testModelId, setTestModelId] = useState("");
	const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
	const [testPending, setTestPending] = useState(false);
	const [discoveryPending, setDiscoveryPending] = useState(false);
	const [replacementProfileId, setReplacementProfileId] = useState<number | null>(null);
	const [pendingDeletionProfileId, setPendingDeletionProfileId] = useState<number | null>(null);
	const [presetChoicesOpen, setPresetChoicesOpen] = useState(false);
	const [headersExpanded, setHeadersExpanded] = useState(false);
	const [conflict, setConflict] = useState<ConnectionSettingsConflict | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		void Promise.all([loadConnectionSettings(), loadConnectionPresets()])
			.then(([loadedSettings, loadedPresets]) => {
				if (cancelled) return;
				setSettings(loadedSettings);
				setPresets(loadedPresets);
				const active = loadedSettings.profiles.find(
					(profile) => profile.id === loadedSettings.activeProfileId,
				);
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
				if (!cancelled) setError("Connection Settings could not be loaded.");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	const selectedProfile = settings?.profiles.find(
		(profile) => profile.id === selectedProfileId,
	);
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

	const choosePreset = (preset: ConnectionPreset) => {
		setSelectedProfileId(null);
		setDraft(copyDraft(preset.profile));
		setCredentialDraft("");
		setHeaderEditorData({});
		setTestModelId(preset.profile.pinnedModels[0] ?? "");
		setTestResult(null);
		setReplacementProfileId(null);
		setPendingDeletionProfileId(null);
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
			};
			if (selectedProfileId !== null) request.profileId = selectedProfileId;
			request.headers = headerOperationsFor(headerEditorData);
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
		if (selectedProfileId === null) {
			setError("Save this connection before refreshing its Models URL.");
			return;
		}
		if (draft.modelsUrl.trim().length === 0) {
			setError("Refresh requires an exact Models URL.");
			return;
		}
		if (selectedProfile?.modelsUrl.trim() !== draft.modelsUrl.trim()) {
			setError("Save the Models URL change before refreshing the catalog.");
			return;
		}
		setDiscoveryPending(true);
		setNotice(null);
		setError(null);
		try {
			const result = await refreshDiscoveryCatalog(selectedProfileId);
			if (result.outcome === "success") {
				setSettings((current) => current === null ? current : {
					...current,
					profiles: current.profiles.map((profile) =>
						profile.id === result.profile.id ? result.profile : profile,
					),
				});
				setNotice(`Model catalog refreshed. ${result.profile.discoveryCatalog.length} model IDs are available for autocomplete.`);
			} else if (result.outcome === "failure") {
				setError(result.message);
			} else if (result.outcome === "invalid") {
				setError(result.reason);
			} else {
				setError("The selected Profile no longer exists.");
			}
		} catch {
			setError("Model catalog refresh could not be completed.");
		} finally {
			setDiscoveryPending(false);
		}
	};

	const applyDraft = async () => {
		if (!settings) return;
		setNotice(null);
		setError(null);
		let headerOperations: ConnectionHeaderOperation[];
		try {
			headerOperations = headerOperationsFor(headerEditorData);
		} catch {
			setError("Custom header drafts are invalid.");
			return;
		}
		const command = selectedProfileId === null
			? {
				type: "create-profile" as const,
				expectedRevision: settings.revision,
				profile: draft,
				credential: credentialDraft.length > 0 ? credentialDraft : null,
				headers: headerOperations,
			}
			: {
				type: "apply-profile" as const,
				expectedRevision: settings.revision,
				profileId: selectedProfileId,
				profile: draft,
				headers: headerOperations,
			};
		const result = await saveConnectionCommand(command);
		if (result.outcome !== "applied") {
			preserveConflict(result);
			setError(
				result.outcome === "conflict"
					? "These settings changed elsewhere. Your unsaved draft is preserved."
					: result.outcome === "invalid"
						? result.reason
						: "The selected Profile no longer exists.",
			);
			return;
		}
		let savedSettings = result.settings;
		if (selectedProfileId !== null && credentialDraft.length > 0) {
			const credentialResult = await saveConnectionCommand({
				type: "set-credential",
				expectedRevision: result.settings.revision,
				profileId: selectedProfileId,
				credential: credentialDraft,
			});
			if (credentialResult.outcome !== "applied") {
				setSettings(
					credentialResult.outcome === "conflict"
						? credentialResult.currentSettings
						: result.settings,
				);
				setError("Connection changes were saved, but the credential could not be updated. Try saving again.");
				return;
			}
			savedSettings = credentialResult.settings;
		}
		setSettings(savedSettings);
		setConflict(null);
		setTestResult(null);
		const saved = savedSettings.profiles.find(
			(profile) =>
				(selectedProfileId !== null && profile.id === selectedProfileId) ||
				(selectedProfileId === null && profile.displayName === draft.displayName.trim().replace(/\s+/g, " ")),
		);
		if (saved) {
			setSelectedProfileId(saved.id);
			setDraft(copyDraft(saved));
			setHeaderEditorData(headerEditorDataFor(saved.headers));
		}
		setCredentialDraft("");
		setNotice("Changes saved. No provider request was made.");
	};

	const activateSelectedProfile = async () => {
		if (!settings || selectedProfileId === null || selectedProfileId === settings.activeProfileId) return;
		setNotice(null);
		setError(null);
		const result = await saveConnectionCommand({
			type: "activate-profile",
			expectedRevision: settings.revision,
			profileId: selectedProfileId,
		});
		if (result.outcome !== "applied") {
			preserveConflict(result);
			setError(result.outcome === "conflict"
				? "These settings changed elsewhere. Your unsaved draft is preserved."
				: result.outcome === "not-found"
					? "The selected Profile no longer exists."
					: result.reason);
			return;
		}
		setSettings(result.settings);
		setConflict(null);
		setNotice("Connection set as active for new generations.");
	};

	const requestProfileDeletion = (profile: ConnectionProfile) => {
		setPendingDeletionProfileId(profile.id);
		setReplacementProfileId(
			profile.id === settings?.activeProfileId
				? settings.profiles.find((entry) => entry.id !== profile.id)?.id ?? null
				: null,
		);
		setNotice(null);
		setError(null);
	};

	const deletePendingProfile = async () => {
		if (!settings || pendingDeletionProfileId === null) return;
		const selected = settings.profiles.find((profile) => profile.id === pendingDeletionProfileId);
		if (!selected) return;
		const deletingActive = selected.id === settings.activeProfileId;
		const replacement = deletingActive && settings.profiles.length > 1
			? replacementProfileId
			: null;
		if (deletingActive && settings.profiles.length > 1 && replacement === null) {
			setError("Choose a replacement Profile before deleting the active Profile.");
			return;
		}
		setNotice(null);
		setError(null);
		const result = await saveConnectionCommand({
			type: "delete-profile",
			expectedRevision: settings.revision,
			profileId: selected.id,
			replacementProfileId: replacement,
		});
		if (result.outcome !== "applied") {
			preserveConflict(result);
			setError(result.outcome === "conflict"
				? "These settings changed elsewhere. Your unsaved draft is preserved."
				: result.outcome === "invalid"
					? result.reason
					: "The selected Profile no longer exists.");
			return;
		}
		setSettings(result.settings);
		setConflict(null);
		setPendingDeletionProfileId(null);
		const nextProfile = result.settings.profiles.find(
			(profile) => profile.id === (replacement ?? result.settings.activeProfileId),
		);
		if (nextProfile) {
			setSelectedProfileId(nextProfile.id);
			setDraft(copyDraft(nextProfile));
			setHeaderEditorData(headerEditorDataFor(nextProfile.headers));
			setReplacementProfileId(result.settings.profiles.find((profile) => profile.id !== nextProfile.id)?.id ?? null);
		} else {
			setSelectedProfileId(null);
			setDraft(copyDraft(emptyDraft));
			setHeaderEditorData({});
			setReplacementProfileId(null);
		}
		setCredentialDraft("");
		setNotice(`${selected.displayName} deleted.`);
	};

	const resetCredential = async () => {
		if (!settings || selectedProfileId === null) return;
		if (!window.confirm("Reset this credential? This cannot be undone.")) return;
		setNotice(null);
		setError(null);
		const result = await saveConnectionCommand({
			type: "reset-credential",
			expectedRevision: settings.revision,
			profileId: selectedProfileId,
			confirmed: true,
		});
		if (result.outcome !== "applied") {
			setError(result.outcome === "invalid" ? result.reason : "Credential reset failed.");
			return;
		}
		setSettings(result.settings);
		setConflict(null);
		setNotice("Credential reset.");
	};

	if (loading) {
		return <div className="panel-body settings-panel-body">Loading Connection Settings...</div>;
	}
	if (!settings) {
		return <div className="panel-body settings-panel-body" role="alert">{error}</div>;
	}

	return (
		<div className="panel-body settings-panel-body connection-settings-panel" data-test-connection-outcome={testResult?.outcome}>
			<section className="connection-profile-section">
				<h3>Connections</h3>
				<p>Choose the connection to edit or add a new one.</p>
				{settings.profiles.length === 0 && (
					<div className="connection-empty-state">
						<strong>Model generation is unconfigured.</strong>
						<span>Add a connection to start generating. Chats and imports remain available.</span>
					</div>
				)}
				{settings.profiles.length > 0 && (
					<div className="connection-profile-list" aria-label="Connections">
						{settings.profiles.map((profile) => (
							<div
								className="connection-profile-card"
								key={profile.id}
								data-selected={profile.id === selectedProfileId}
								data-active={profile.id === settings.activeProfileId}
							>
								<button
									className="connection-profile-choice"
									type="button"
									onClick={() => chooseProfile(profile)}
								>
									<span>{profile.displayName}</span>
									<small>
										{profile.id === settings.activeProfileId ? (
											<strong><Check aria-hidden="true" /> Active</strong>
										) : "Available"}
										{profile.credentialConfigured ? ", credential configured" : ", no credential"}
									</small>
								</button>
								<details className="connection-profile-menu">
									<summary aria-label={`More actions for ${profile.displayName}`}>
										<Ellipsis aria-hidden="true" />
									</summary>
									<div>
										<button type="button" onClick={(event) => {
											event.currentTarget.closest("details")?.removeAttribute("open");
											requestProfileDeletion(profile);
										}}>
											<Trash2 aria-hidden="true" /> Delete profile
										</button>
									</div>
								</details>
							</div>
						))}
					</div>
				)}
				{pendingDeletionProfileId !== null && (() => {
					const pendingProfile = settings.profiles.find((profile) => profile.id === pendingDeletionProfileId);
					if (!pendingProfile) return null;
					const needsReplacement = pendingProfile.id === settings.activeProfileId && settings.profiles.length > 1;
					return (
						<div className="connection-delete-confirmation" role="group" aria-label={`Delete ${pendingProfile.displayName}`}>
							<div>
								<strong>Delete {pendingProfile.displayName}?</strong>
								<span>This cannot be undone.</span>
							</div>
							{needsReplacement && (
							<label className="field">
								<span>Set another connection as active</span>
								<select
									className="field-input"
									value={replacementProfileId ?? ""}
									onChange={(event) => setReplacementProfileId(event.target.value.length > 0 ? Number(event.target.value) : null)}
								>
									<option value="">Choose a connection</option>
									{settings.profiles.filter((profile) => profile.id !== pendingProfile.id).map((profile) => (
										<option key={profile.id} value={profile.id}>{profile.displayName}</option>
									))}
								</select>
							</label>
						)}
							<div className="connection-delete-actions">
								<button className="secondary-button" type="button" onClick={() => setPendingDeletionProfileId(null)}>Cancel</button>
								<button className="danger-button" type="button" onClick={() => void deletePendingProfile()}>
									<Trash2 aria-hidden="true" /> Delete profile
								</button>
							</div>
						</div>
					);
				})()}
				<div className="connection-add-area">
					<button
						className="secondary-button"
						type="button"
						aria-expanded={presetChoicesOpen}
						onClick={() => setPresetChoicesOpen((current) => !current)}
					>
						<Plus aria-hidden="true" /> Add connection
					</button>
					{presetChoicesOpen && (
						<div className="connection-preset-list" aria-label="Connection presets">
							{presets.map((preset) => (
								<button type="button" className="secondary-button" key={preset.id} onClick={() => choosePreset(preset)}>
									{preset.label === "Generic OpenAI Compatible" ? "OpenAI Compatible" : preset.label}
								</button>
							))}
						</div>
					)}
				</div>
			</section>

			{(selectedProfile !== undefined || draft.displayName.length > 0) && <section className="connection-editor-section">
				<div className="connection-editor-heading">
					<div>
						<h3>{selectedProfile ? `Edit ${selectedProfile.displayName}` : "New connection"}</h3>
						<span>{selectedProfile?.id === settings.activeProfileId ? "Active for new generations" : selectedProfile ? "Saved, not active" : "Not saved yet"}</span>
					</div>
					{selectedProfile && selectedProfile.id !== settings.activeProfileId && (
						<button className="secondary-button connection-activate-button" type="button" onClick={() => void activateSelectedProfile()}>
							<Zap aria-hidden="true" /> Set as active
						</button>
					)}
				</div>
				<div className="definition-form">
					<label className="field">
						<span>Display name</span>
						<input className="field-input" value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
					</label>
					<label className="field">
						<span>Provider</span>
						<div className="field-input connection-provider-value">
							{draft.adapter === "deepseek" ? "DeepSeek" : draft.adapter === "openrouter" ? "OpenRouter" : "OpenAI Compatible"}
						</div>
					</label>
					<label className="field">
						<span>Credential</span>
						<div className="credential-field-row">
							<div className="credential-input-row">
								<KeyRound aria-hidden="true" />
								<input className="field-input" type="password" autoComplete="new-password" value={credentialDraft} onChange={(event) => setCredentialDraft(event.target.value)} placeholder={selectedProfile?.credentialConfigured ? "Configured; enter to replace" : "Enter API key"} />
							</div>
							{selectedProfile?.credentialConfigured && (
								<button className="secondary-button" type="button" onClick={() => void resetCredential()}>
									<RotateCcw aria-hidden="true" /> Reset
								</button>
							)}
						</div>
						<small>{credentialDraft.length > 0 ? "Save this credential before testing it." : "The stored credential is write-only."}</small>
					</label>
					<label className="field">
						<span>Default and test model</span>
						<input
							className="field-input"
							value={testModelId}
							onChange={(event) => {
								const value = event.target.value;
								setTestModelId(value);
								setDraft({ ...draft, pinnedModels: value.length > 0 ? [value, ...draft.pinnedModels.slice(1)] : [] });
							}}
							placeholder="deepseek-chat"
							list={`connection-models-${selectedProfileId ?? "new"}`}
						/>
						<datalist id={`connection-models-${selectedProfileId ?? "new"}`}>
							{Array.from(new Set([...(selectedProfile?.discoveryCatalog ?? []), ...draft.pinnedModels])).map((modelId) => <option key={modelId} value={modelId} />)}
						</datalist>
						<small>Used for connection tests and saved as the default model.</small>
					</label>

					<details className="connection-advanced-settings">
						<summary><span>Advanced settings</span><ChevronDown aria-hidden="true" /></summary>
						<div className="connection-advanced-content">
					<label className="field">
						<span>Request URL</span>
						<input className="field-input" value={draft.requestUrl} onChange={(event) => setDraft({ ...draft, requestUrl: event.target.value })} placeholder="https://example.com/" />
						<small>Resolved destination: {resolvedRequestUrl}</small>
					</label>
					<div className="connection-models-url">
						<label className="field">
							<span>Models URL <em>(optional, exact endpoint)</em></span>
							<input className="field-input" value={draft.modelsUrl} onChange={(event) => setDraft({ ...draft, modelsUrl: event.target.value })} placeholder="https://example.com/models" />
						</label>
						<button
							className="secondary-button"
							type="button"
							disabled={selectedProfileId === null || selectedProfile?.modelsUrl.trim() !== draft.modelsUrl.trim() || draft.modelsUrl.trim().length === 0 || discoveryPending}
							onClick={() => void refreshModels()}
						>
							{discoveryPending ? "Refreshing..." : "Refresh Models"}
						</button>
						<small>
							{selectedProfile === undefined
								? "Save the connection before refreshing."
								: `${selectedProfile.discoveryCatalog.length} discovered model IDs cached for autocomplete.`}
						</small>
					</div>
					<div className="connection-header-editor">
						<div className="connection-header-heading">
							<div><h4>Custom headers</h4>{Object.keys(headerEditorData).length === 0 && <span>No custom headers</span>}</div>
							{!headersExpanded && <button className="secondary-button" type="button" onClick={() => setHeadersExpanded(true)}><Plus aria-hidden="true" /> Add header</button>}
						</div>
						{headersExpanded && (
							<>
								<JsonEditor
									data={headerEditorData}
									setData={(value) => setHeaderEditorData(parseHeaderEditorData(value))}
									rootName="Headers"
									showStringQuotes={false}
									restrictDrag
								/>
								<small>Values are write-only. Keep preserves a stored value, Replace updates it, and Remove deletes it.</small>
							</>
						)}
					</div>
					<div className="connection-advanced-grid">
						<label className="field"><span>API Format</span><select className="field-input" value={draft.apiFormat} onChange={(event) => { /* SAFETY: the select offers only the Chat Completions option. */ setDraft({ ...draft, apiFormat: event.target.value as ConnectionProfileDraft["apiFormat"] }); }}><option value="chat-completions">Chat Completions</option></select></label>
						<label className="field"><span>Model Backend</span><select className="field-input" value={draft.modelBackend} onChange={(event) => { /* SAFETY: options are the closed v1 Model Backend vocabulary. */ setDraft({ ...draft, modelBackend: event.target.value as ConnectionProfileDraft["modelBackend"] }); }}><option value="automatic">Automatic</option><option value="ai-sdk">AI SDK</option></select></label>
						<label className="field"><span>AI SDK Adapter</span><select className="field-input" value={draft.adapter} onChange={(event) => { /* SAFETY: options are the three bundled adapter identifiers. */ setDraft({ ...draft, adapter: event.target.value as ConnectionProfileDraft["adapter"] }); }}><option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option><option value="openai-compatible">OpenAI Compatible</option></select></label>
						<label className="field"><span>Output-token representation</span><select className="field-input" value={draft.outputTokenRepresentation} onChange={(event) => { const value = event.target.value; setDraft({ ...draft, outputTokenRepresentation: value === "max_tokens" || value === "max_completion_tokens" || value === "omit" ? value : "automatic" }); }}><option value="automatic">Automatic</option><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option><option value="omit">Omit remote limit</option></select></label>
						<label className="field"><span>Stream inactivity timeout</span><input className="field-input" type="number" min="0" step="1000" value={draft.timeoutMs ?? ""} onChange={(event) => setDraft({ ...draft, timeoutMs: event.target.value.length === 0 ? null : Number(event.target.value) })} placeholder="120000" /><small>Milliseconds. Use zero or blank to disable.</small></label>
					</div>
						</div>
					</details>
					<div className="connection-action-row">
						<button className="secondary-button" type="button" disabled={testPending} onClick={() => void testDraft()}><Zap aria-hidden="true" /> {testPending ? "Testing..." : "Test connection"}</button>
						<button className="primary-button" type="button" onClick={() => void applyDraft()}><Save aria-hidden="true" /> {selectedProfile ? "Save changes" : "Save connection"}</button>
					</div>
					<small className="connection-test-warning">Testing contacts the provider and may incur a charge. It does not save changes.</small>
				</div>
			</section>}

			{(notice || error || conflict) && <p className={error ? "connection-feedback connection-feedback-error" : "connection-feedback"} role={error ? "alert" : "status"}>{error ?? notice}{conflict && <small> Authoritative revision {conflict.actualRevision} is loaded. Review the draft before retrying.</small>}</p>}
			<div className="connection-security-note"><ShieldCheck aria-hidden="true" /><span>Credentials and custom headers stay outside Conversation data and are never returned to the client.</span></div>
		</div>
	);
}
