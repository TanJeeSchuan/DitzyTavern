import { ChevronDown, KeyRound, Plus, RotateCcw, Save, Zap } from "lucide-react";
import { JsonEditor } from "json-edit-react";
import type { ConnectionProfileDraft } from "../../connection-settings";
import { parseHeaderEditorData, type ConnectionSettingsController } from "./useConnectionSettingsController";

type Props = { controller: ConnectionSettingsController };

export function ConnectionProfileEditor({ controller }: Props) {
	const {
		draft, selectedProfile, selectedProfileId, credentialDraft, testModelId, headerEditorData,
		headersExpanded, testPending, discoveryPending, resolvedRequestUrl, refreshModelsDisabledReason,
		setDraft, setCredentialDraft, setTestModelId, setHeaderEditorData, setHeadersExpanded,
		testDraft, refreshModels, applyDraft, updateCredential, resetCredential, activateSelectedProfile,
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

				<details className="connection-advanced-settings">
					<summary><span>Advanced settings</span><ChevronDown aria-hidden="true" /></summary>
					<div className="connection-advanced-content">
						<label className="field"><span>Request URL</span><input className="field-input" value={draft.requestUrl} onChange={(event) => updateDraft({ requestUrl: event.target.value })} placeholder="https://example.com/" /><small>Resolved destination: {resolvedRequestUrl}</small></label>
						<div className="connection-models-url">
							<label className="field"><span>Models URL <em>(optional, exact endpoint)</em></span><input className="field-input" value={draft.modelsUrl} onChange={(event) => updateDraft({ modelsUrl: event.target.value })} placeholder="https://example.com/models" /></label>
							<span className="connection-refresh-models-button" title={refreshModelsDisabledReason}><button className="secondary-button" type="button" disabled={refreshModelsDisabledReason !== undefined} onClick={() => void refreshModels()}>{discoveryPending ? "Refreshing..." : "Refresh Models"}</button></span>
							<small>{selectedProfile === undefined ? "Save the connection before refreshing." : `${selectedProfile.discoveryCatalog.length} model names available as suggestions.`}</small>
						</div>
						<div className="connection-header-editor">
							<div className="connection-header-heading"><div><h4>Custom headers</h4>{Object.keys(headerEditorData).length === 0 && <span>No custom headers</span>}</div>{!headersExpanded && <button className="secondary-button" type="button" onClick={() => setHeadersExpanded(true)}><Plus aria-hidden="true" /> Add header</button>}</div>
							{headersExpanded && <><JsonEditor data={headerEditorData} setData={(value) => setHeaderEditorData(parseHeaderEditorData(value))} rootName="Headers" showStringQuotes={false} restrictDrag /><small>Saved header values are never shown. Keep leaves a value unchanged, Replace updates it, and Remove deletes it.</small></>}
						</div>
						<div className="connection-advanced-grid">
							<label className="field"><span>API Format</span><select className="field-input" value={draft.apiFormat} onChange={() => updateDraft({ apiFormat: "chat-completions" })}><option value="chat-completions">Chat Completions</option></select></label>
							<label className="field"><span>Model Backend</span><select className="field-input" value={draft.modelBackend} onChange={(event) => updateDraft({ modelBackend: event.target.value === "ai-sdk" ? "ai-sdk" : "automatic" })}><option value="automatic">Automatic</option><option value="ai-sdk">AI SDK</option></select></label>
							<label className="field"><span>AI SDK Adapter</span><select className="field-input" value={draft.adapter} onChange={(event) => { const value = event.target.value; updateDraft({ adapter: value === "deepseek" || value === "openrouter" ? value : "openai-compatible" }); }}><option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option><option value="openai-compatible">OpenAI Compatible</option></select></label>
							<label className="field"><span>Output-token representation</span><select className="field-input" value={draft.outputTokenRepresentation} onChange={(event) => { const value = event.target.value; updateDraft({ outputTokenRepresentation: value === "max_tokens" || value === "max_completion_tokens" || value === "omit" ? value : "automatic" }); }}><option value="automatic">Automatic</option><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option><option value="omit">Omit remote limit</option></select></label>
							<label className="field"><span>Stream inactivity timeout</span><input className="field-input" type="number" min="0" step="1000" value={draft.timeoutMs ?? ""} onChange={(event) => updateDraft({ timeoutMs: event.target.value.length === 0 ? null : Number(event.target.value) })} placeholder="120000" /><small>Milliseconds. Use zero or blank to disable.</small></label>
						</div>
					</div>
				</details>
				<div className="connection-action-row"><button className="secondary-button" type="button" disabled={testPending} onClick={() => void testDraft()}><Zap aria-hidden="true" /> {testPending ? "Testing..." : "Test connection"}</button><button className="primary-button" type="button" onClick={() => void applyDraft()}><Save aria-hidden="true" /> {selectedProfile ? "Save changes" : "Save connection"}</button></div>
				<small className="connection-test-warning">Testing contacts the provider and may incur a charge. It does not save changes.</small>
			</div>
		</section>
	);
}
