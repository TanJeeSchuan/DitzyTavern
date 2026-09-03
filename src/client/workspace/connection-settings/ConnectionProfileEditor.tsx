import { KeyRound, RotateCcw, Save, SlidersHorizontal, Zap } from "lucide-react";
import type { ConnectionProfileDraft } from "../../connection-settings";
import type { ConnectionSettingsController } from "./useConnectionSettingsController";

type Props = {
	controller: ConnectionSettingsController;
	onOpenInspector: () => void;
};

export function ConnectionProfileEditor({ controller, onOpenInspector }: Props) {
	const {
		draft,
		selectedProfile,
		selectedProfileId,
		credentialDraft,
		testModelId,
		testPending,
		setDraft,
		setCredentialDraft,
		setTestModelId,
		testDraft,
		applyDraft,
		updateCredential,
		resetCredential,
		activateSelectedProfile,
	} = controller;
	const updateDraft = (patch: Partial<ConnectionProfileDraft>) => setDraft({ ...draft, ...patch });

	return (
		<section className="connection-editor-section">
			<div className="connection-editor-heading">
				<div>
					<h3>{selectedProfile ? `Edit ${selectedProfile.displayName}` : "New connection"}</h3>
					<span>{selectedProfile?.id === controller.settings?.activeProfileId ? "Active for new generations" : selectedProfile ? "Saved, not active" : "Not saved yet"}</span>
				</div>
				{selectedProfile && selectedProfile.id !== controller.settings?.activeProfileId && (
					<button className="secondary-button connection-activate-button" type="button" onClick={() => void activateSelectedProfile()}><Zap aria-hidden="true" /> Set as active</button>
				)}
			</div>
			<div className="definition-form">
				<label className="field"><span>Display name</span><input className="field-input" value={draft.displayName} onChange={(event) => updateDraft({ displayName: event.target.value })} /></label>
				<label className="field"><span>Provider</span><div className="field-input connection-provider-value">{draft.adapter === "deepseek" ? "DeepSeek" : draft.adapter === "openrouter" ? "OpenRouter" : "OpenAI Compatible"}</div></label>
				<label className="field">
					<span>Credential</span>
					<div className="credential-field-row">
						<div className="credential-input-row"><KeyRound aria-hidden="true" /><input className="field-input" type="password" autoComplete="new-password" value={credentialDraft} onChange={(event) => setCredentialDraft(event.target.value)} placeholder={selectedProfile?.credentialConfigured ? "Configured; enter to replace" : "Enter API key"} /></div>
						{selectedProfile?.credentialConfigured && <button className="secondary-button" type="button" onClick={() => void resetCredential()}><RotateCcw aria-hidden="true" /> Reset</button>}
						{selectedProfile && credentialDraft.length > 0 && <button className="secondary-button" type="button" onClick={() => void updateCredential()}><KeyRound aria-hidden="true" /> Update credential</button>}
					</div>
					<small>{credentialDraft.length > 0 && selectedProfile ? "Update this credential before testing it." : credentialDraft.length > 0 ? "The credential will be saved when this connection is created." : "Saved credentials cannot be viewed. Enter a new one to replace it."}</small>
				</label>
				<label className="field">
					<span>Default and test model</span>
					<input className="field-input" value={testModelId} onChange={(event) => { const value = event.target.value; setTestModelId(value); updateDraft({ pinnedModels: value.length > 0 ? [value, ...draft.pinnedModels.slice(1)] : [] }); }} placeholder="deepseek-chat" list={`connection-models-${selectedProfileId ?? "new"}`} />
					<datalist id={`connection-models-${selectedProfileId ?? "new"}`}>{Array.from(new Set([...(selectedProfile?.discoveryCatalog ?? []), ...draft.pinnedModels])).map((modelId) => <option key={modelId} value={modelId} />)}</datalist>
					<small>Used for connection tests and saved as the default model.</small>
				</label>

				<ConnectionAdvancedSummary controller={controller} onOpenInspector={onOpenInspector} />

				<div className="connection-action-row">
					<button className="secondary-button" type="button" disabled={testPending || !controller.canSave} onClick={() => void testDraft()}><Zap aria-hidden="true" /> {testPending ? "Testing..." : "Test connection"}</button>
					<button className="primary-button" type="button" disabled={!controller.canSave} onClick={() => void applyDraft()}><Save aria-hidden="true" /> {selectedProfile ? "Save changes" : "Save connection"}</button>
				</div>
				{controller.basicValidationError !== null && <small className="field-error connection-validation-error" role="alert">{controller.basicValidationError}</small>}
				<small className="connection-test-warning">Testing contacts the provider and may incur a charge. It does not save changes.</small>
			</div>
		</section>
	);
}

function ConnectionAdvancedSummary({
	controller,
	onOpenInspector,
}: {
	controller: ConnectionSettingsController;
	onOpenInspector: () => void;
}) {
	const { draft, headerEditorData, resolvedRequestUrl } = controller;
	const configuredHeaderCount = Object.values(headerEditorData).filter((header) => header.configured && header.operation !== "remove").length;
	const pendingHeaderCount = Object.values(headerEditorData).filter((header) => !header.configured || header.operation !== "keep").length;
	return (
		<section className="connection-advanced-summary" aria-labelledby="connection-advanced-summary-title">
			<div className="settings-summary-heading">
				<div>
					<h3 id="connection-advanced-summary-title">Advanced settings</h3>
					<p>Endpoints, headers, and transport details are ready in the inspector.</p>
				</div>
				<SlidersHorizontal aria-hidden="true" />
			</div>
			<dl className="settings-summary-list">
				<div><dt>Request URL</dt><dd>{resolvedRequestUrl}</dd></div>
				<div><dt>Models URL</dt><dd>{draft.modelsUrl.trim().length > 0 ? draft.modelsUrl : "Not configured"}</dd></div>
				<div><dt>Custom headers</dt><dd>{configuredHeaderCount === 0 ? "No configured headers" : `${configuredHeaderCount} configured`}{pendingHeaderCount > 0 ? ` · ${pendingHeaderCount} unsaved` : ""}</dd></div>
				<div><dt>Transport</dt><dd>{draft.apiFormat === "chat-completions" ? "Chat Completions" : draft.apiFormat} · {draft.modelBackend === "automatic" ? "Automatic backend" : "AI SDK"}</dd></div>
			</dl>
			<button className="secondary-button settings-inspector-entry" type="button" onClick={onOpenInspector}>
				<SlidersHorizontal aria-hidden="true" /> Edit in inspector
			</button>
		</section>
	);
}
