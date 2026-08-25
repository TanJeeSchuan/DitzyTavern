import { Check, KeyRound, RotateCcw, Save, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	loadConnectionPresets,
	loadConnectionSettings,
	saveConnectionCommand,
	type ConnectionProfile,
	type ConnectionProfileDraft,
	type ConnectionPreset,
	type ConnectionSettings,
} from "../connection-settings";

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
	backendOptions: {},
};

const copyDraft = (profile: ConnectionProfileDraft): ConnectionProfileDraft => ({
	...profile,
	pinnedModels: [...profile.pinnedModels],
	backendOptions: { ...profile.backendOptions },
});

export function ConnectionSettingsPanel() {
	const [settings, setSettings] = useState<ConnectionSettings | null>(null);
	const [presets, setPresets] = useState<ConnectionPreset[]>([]);
	const [draft, setDraft] = useState<ConnectionProfileDraft>(emptyDraft);
	const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null);
	const [credentialDraft, setCredentialDraft] = useState("");
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
		const value = draft.requestUrl.trim();
		if (value.length === 0) return "Not configured";
		return value.endsWith("/") ? `${value}chat/completions` : value;
	}, [draft.requestUrl]);

	const choosePreset = (preset: ConnectionPreset) => {
		setSelectedProfileId(null);
		setDraft(copyDraft(preset.profile));
		setCredentialDraft("");
		setNotice(`${preset.label} defaults copied into a new editable Profile draft.`);
		setError(null);
	};

	const chooseProfile = (profile: ConnectionProfile) => {
		setSelectedProfileId(profile.id);
		setDraft(copyDraft(profile));
		setCredentialDraft("");
		setNotice(null);
		setError(null);
	};

	const applyDraft = async () => {
		if (!settings) return;
		setNotice(null);
		setError(null);
		const command = selectedProfileId === null
			? {
				type: "create-profile" as const,
				expectedRevision: settings.revision,
				profile: draft,
				credential: credentialDraft.length > 0 ? credentialDraft : null,
			}
			: {
				type: "apply-profile" as const,
				expectedRevision: settings.revision,
				profileId: selectedProfileId,
				profile: draft,
			};
		const result = await saveConnectionCommand(command);
		if (result.outcome !== "applied") {
			setError(
				result.outcome === "conflict"
					? "These settings changed elsewhere. Your unsaved draft is preserved."
					: result.outcome === "invalid"
						? result.reason
						: "The selected Profile no longer exists.",
			);
			return;
		}
		setSettings(result.settings);
		const saved = result.settings.profiles.find(
			(profile) =>
				(selectedProfileId !== null && profile.id === selectedProfileId) ||
				(selectedProfileId === null && profile.displayName === draft.displayName.trim().replace(/\s+/g, " ")),
		);
		if (saved) {
			setSelectedProfileId(saved.id);
			setDraft(copyDraft(saved));
		}
		setCredentialDraft("");
		setNotice("Connection Profile applied offline. No provider request was made.");
	};

	const setCredential = async () => {
		if (!settings || selectedProfileId === null || credentialDraft.length === 0) return;
		setNotice(null);
		setError(null);
		const result = await saveConnectionCommand({
			type: "set-credential",
			expectedRevision: settings.revision,
			profileId: selectedProfileId,
			credential: credentialDraft,
		});
		if (result.outcome !== "applied") {
			setError(result.outcome === "invalid" ? result.reason : "Credential update failed.");
			return;
		}
		setSettings(result.settings);
		setCredentialDraft("");
		setNotice("Credential updated. The stored value is never returned to this page.");
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
		setNotice("Credential reset.");
	};

	if (loading) {
		return <div className="panel-body settings-panel-body">Loading Connection Settings...</div>;
	}
	if (!settings) {
		return <div className="panel-body settings-panel-body" role="alert">{error}</div>;
	}

	return (
		<div className="panel-body settings-panel-body connection-settings-panel">
			<section>
				<h3>Connection Profiles</h3>
				<p>
					Global model access is separate from Conversation data. Apply saves the
					current draft without contacting a provider.
				</p>
				{settings.profiles.length === 0 && (
					<div className="connection-empty-state">
						<strong>Model generation is unconfigured.</strong>
						<span>Create a Profile when you are ready. Chats and imports remain available.</span>
					</div>
				)}
				{settings.profiles.length > 0 && (
					<div className="connection-profile-list" aria-label="Connection Profiles">
						{settings.profiles.map((profile) => (
							<button
								className="connection-profile-choice"
								type="button"
								key={profile.id}
								data-active={profile.id === selectedProfileId}
								onClick={() => chooseProfile(profile)}
							>
								<span>{profile.displayName}</span>
								<small>
									{profile.id === settings.activeProfileId ? "Active" : "Available"}
									{profile.credentialConfigured ? " · Credential configured" : " · No credential"}
								</small>
							</button>
						))}
					</div>
				)}
			</section>

			<section className="connection-presets">
				<h3>Start from a Preset</h3>
				<div className="connection-preset-list">
					{presets.map((preset) => (
						<button type="button" className="secondary-button" key={preset.id} onClick={() => choosePreset(preset)}>
							{preset.label}
						</button>
					))}
				</div>
			</section>

			<section className="connection-editor-section">
				<div className="connection-editor-heading">
					<div>
						<h3>{selectedProfile ? `Edit ${selectedProfile.displayName}` : "New Connection Profile"}</h3>
						<span>{selectedProfile ? `Revision ${settings.revision}` : "The first saved Profile becomes active."}</span>
					</div>
					<ShieldCheck aria-hidden="true" />
				</div>
				<div className="definition-form">
					<label className="field">
						<span>Display name</span>
						<input className="field-input" value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
					</label>
					<label className="field">
						<span>Request URL</span>
						<input className="field-input" value={draft.requestUrl} onChange={(event) => setDraft({ ...draft, requestUrl: event.target.value })} placeholder="https://example.com/" />
						<small>Resolved destination: {resolvedRequestUrl}</small>
					</label>
					<label className="field">
						<span>Models URL <em>(optional)</em></span>
						<input className="field-input" value={draft.modelsUrl} onChange={(event) => setDraft({ ...draft, modelsUrl: event.target.value })} placeholder="https://example.com/models" />
					</label>
					<label className="field">
						<span>Dedicated credential</span>
						<div className="credential-input-row">
							<KeyRound aria-hidden="true" />
							<input className="field-input" type="password" autoComplete="new-password" value={credentialDraft} onChange={(event) => setCredentialDraft(event.target.value)} placeholder={selectedProfile?.credentialConfigured ? "Configured · enter to replace" : "Optional for now"} />
						</div>
						<small>Stored encrypted. The value is write-only.</small>
					</label>
					<div className="connection-advanced-grid">
						<label className="field"><span>API Format</span><select className="field-input" value={draft.apiFormat} onChange={(event) => { /* SAFETY: the select offers only the Chat Completions option. */ setDraft({ ...draft, apiFormat: event.target.value as ConnectionProfileDraft["apiFormat"] }); }}><option value="chat-completions">Chat Completions</option></select></label>
						<label className="field"><span>Model Backend</span><select className="field-input" value={draft.modelBackend} onChange={(event) => { /* SAFETY: options are the closed v1 Model Backend vocabulary. */ setDraft({ ...draft, modelBackend: event.target.value as ConnectionProfileDraft["modelBackend"] }); }}><option value="automatic">Automatic</option><option value="ai-sdk">AI SDK</option></select></label>
						<label className="field"><span>AI SDK Adapter</span><select className="field-input" value={draft.adapter} onChange={(event) => { /* SAFETY: options are the three bundled adapter identifiers. */ setDraft({ ...draft, adapter: event.target.value as ConnectionProfileDraft["adapter"] }); }}><option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option><option value="openai-compatible">OpenAI Compatible</option></select></label>
					</div>
					{draft.pinnedModels.length > 0 && <small className="pinned-models-note">Pinned defaults: {draft.pinnedModels.join(", ")}</small>}
					<div className="connection-action-row">
						<button className="primary-button" type="button" onClick={() => void applyDraft()}><Save aria-hidden="true" /> Apply Profile</button>
						{selectedProfile && credentialDraft.length > 0 && <button className="secondary-button" type="button" onClick={() => void setCredential()}><KeyRound aria-hidden="true" /> Set Credential</button>}
						{selectedProfile?.credentialConfigured && <button className="secondary-button" type="button" onClick={() => void resetCredential()}><RotateCcw aria-hidden="true" /> Reset Credential</button>}
					</div>
				</div>
			</section>

			{(notice || error) && <p className={error ? "connection-feedback connection-feedback-error" : "connection-feedback"} role={error ? "alert" : "status"}>{error ?? notice}</p>}
			<div className="connection-security-note"><ShieldCheck aria-hidden="true" /><span>Credentials and custom headers stay outside Conversation state and are never returned to the client.</span></div>
			{selectedProfile && <p className="connection-active-note">{selectedProfile.id === settings.activeProfileId ? <><Check aria-hidden="true" /> This Profile is active for new Generations.</> : "This Profile is saved but not active yet."}</p>}
		</div>
	);
}
