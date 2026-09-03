import { JsonEditor } from "json-edit-react";
import type { ConnectionProfileDraft } from "../../connection-settings";
import { parseHeaderEditorData, type ConnectionSettingsController } from "./useConnectionSettingsController";

export function ConnectionProfileAdvancedEditor({
	controller,
}: {
	controller: ConnectionSettingsController;
}) {
	const {
		draft,
		selectedProfile,
		headerEditorData,
		discoveryPending,
		resolvedRequestUrl,
		refreshModelsDisabledReason,
		setDraft,
		setHeaderEditorData,
		refreshModels,
	} = controller;
	const updateDraft = (patch: Partial<ConnectionProfileDraft>) => setDraft({ ...draft, ...patch });

	return (
		<section className="connection-inspector-editor" aria-labelledby="connection-inspector-title">
			<h3 id="connection-inspector-title">Advanced settings</h3>
			<div className="connection-advanced-content">
				<label className="field"><span>Request URL</span><input className="field-input" value={draft.requestUrl} onChange={(event) => updateDraft({ requestUrl: event.target.value })} placeholder="https://example.com/" /><small>Resolved destination: {resolvedRequestUrl}</small></label>
				<div className="connection-models-url">
					<label className="field"><span>Models URL <em>(optional, exact endpoint)</em></span><input className="field-input" value={draft.modelsUrl} onChange={(event) => updateDraft({ modelsUrl: event.target.value })} placeholder="https://example.com/models" /></label>
					<span className="connection-refresh-models-button" title={refreshModelsDisabledReason}><button className="secondary-button" type="button" disabled={refreshModelsDisabledReason !== undefined} onClick={() => void refreshModels()}>{discoveryPending ? "Refreshing..." : "Refresh Models"}</button></span>
					<small>{selectedProfile === undefined ? "Save the connection before refreshing." : `${selectedProfile.discoveryCatalog.length} model names available as suggestions.`}</small>
				</div>
				<div className="connection-header-editor">
					<div className="connection-header-heading"><div><h4>Custom headers</h4>{Object.keys(headerEditorData).length === 0 && <span>No custom headers</span>}</div></div>
					<JsonEditor data={headerEditorData} setData={(value) => setHeaderEditorData(parseHeaderEditorData(value))} rootName="Headers" showStringQuotes={false} restrictDrag />
					<small>Saved header values are never shown. Keep leaves a value unchanged, Replace updates it, and Remove deletes it.</small>
				</div>
				<div className="connection-advanced-grid">
					<label className="field"><span>API Format</span><select className="field-input" value={draft.apiFormat} onChange={() => updateDraft({ apiFormat: "chat-completions" })}><option value="chat-completions">Chat Completions</option></select></label>
					<label className="field"><span>Model Backend</span><select className="field-input" value={draft.modelBackend} onChange={(event) => updateDraft({ modelBackend: event.target.value === "ai-sdk" ? "ai-sdk" : "automatic" })}><option value="automatic">Automatic</option><option value="ai-sdk">AI SDK</option></select></label>
					<label className="field"><span>AI SDK Adapter</span><select className="field-input" value={draft.adapter} onChange={(event) => { const value = event.target.value; updateDraft({ adapter: value === "deepseek" || value === "openrouter" ? value : "openai-compatible" }); }}><option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option><option value="openai-compatible">OpenAI Compatible</option></select></label>
					<label className="field"><span>Output-token representation</span><select className="field-input" value={draft.outputTokenRepresentation} onChange={(event) => { const value = event.target.value; updateDraft({ outputTokenRepresentation: value === "max_tokens" || value === "max_completion_tokens" || value === "omit" ? value : "automatic" }); }}><option value="automatic">Automatic</option><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option><option value="omit">Omit remote limit</option></select></label>
					<label className="field"><span>Stream inactivity timeout</span><input className="field-input" type="number" min="0" step="1000" value={draft.timeoutMs ?? ""} onChange={(event) => updateDraft({ timeoutMs: event.target.value.length === 0 ? null : Number(event.target.value) })} placeholder="120000" /><small>Milliseconds. Use zero or blank to disable.</small></label>
				</div>
				{controller.advancedValidationError !== null && <small className="field-error connection-validation-error" role="alert">{controller.advancedValidationError}</small>}
			</div>
		</section>
	);
}
