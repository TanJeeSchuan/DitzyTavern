import { JsonEditor } from "json-edit-react";
import { AppSelect } from "@/components/ui/select";
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
		resolvedRequestUrl,
		setDraft,
		setHeaderEditorData,
	} = controller;
	const updateDraft = (patch: Partial<ConnectionProfileDraft>) => setDraft({ ...draft, ...patch });

	return (
		<section className="connection-inspector-editor" aria-labelledby="connection-inspector-title">
			<h3 id="connection-inspector-title">Advanced settings</h3>
			<div className="connection-advanced-content">
				<label className="field"><span>Request URL</span><input className="field-input" value={draft.requestUrl} onChange={(event) => updateDraft({ requestUrl: event.target.value })} placeholder="https://example.com/" /><small>Resolved destination: {resolvedRequestUrl}</small></label>
				<div className="connection-models-url">
					<label className="field"><span>Models URL <em>(optional, exact endpoint)</em></span><input className="field-input" value={draft.modelsUrl} onChange={(event) => updateDraft({ modelsUrl: event.target.value })} placeholder="https://example.com/models" /></label>
					<small>{selectedProfile === undefined ? "Save the connection to refresh its model catalog." : `${selectedProfile.discoveryCatalog.length} model names available as suggestions.`}</small>
				</div>
				<div className="connection-header-editor">
					<div className="connection-header-heading"><div><h4>Custom headers</h4>{Object.keys(headerEditorData).length === 0 && <span>No custom headers</span>}</div></div>
					<JsonEditor data={headerEditorData} setData={(value) => setHeaderEditorData(parseHeaderEditorData(value))} rootName="Headers" showStringQuotes={false} restrictDrag />
					<small>Saved header values are never shown. Keep leaves a value unchanged, Replace updates it, and Remove deletes it.</small>
				</div>
				<div className="connection-advanced-grid">
					<div className="field"><span>API Format</span><div className="field-input">Chat Completions</div></div>
					<label className="field"><span>Model Backend</span><AppSelect className="field-input" value={draft.modelBackend} onValueChange={(value) => updateDraft({ modelBackend: value === "ai-sdk" ? "ai-sdk" : "automatic" })} options={[{ value: "automatic", label: "Automatic" }, { value: "ai-sdk", label: "AI SDK" }]} /></label>
					<label className="field"><span>AI SDK Adapter</span><AppSelect className="field-input" value={draft.adapter} onValueChange={(value) => updateDraft({ adapter: value === "deepseek" || value === "openrouter" ? value : "openai-compatible" })} options={[{ value: "deepseek", label: "DeepSeek" }, { value: "openrouter", label: "OpenRouter" }, { value: "openai-compatible", label: "OpenAI Compatible" }]} /></label>
					<label className="field"><span>Output-token representation</span><AppSelect className="field-input" value={draft.outputTokenRepresentation} onValueChange={(value) => updateDraft({ outputTokenRepresentation: value === "max_tokens" || value === "max_completion_tokens" || value === "omit" ? value : "automatic" })} options={[{ value: "automatic", label: "Automatic" }, { value: "max_tokens", label: "max_tokens" }, { value: "max_completion_tokens", label: "max_completion_tokens" }, { value: "omit", label: "Omit remote limit" }]} /></label>
					<label className="field"><span>Stream inactivity timeout</span><input className="field-input" type="number" min="0" step="1000" value={draft.timeoutMs ?? ""} onChange={(event) => updateDraft({ timeoutMs: event.target.value.length === 0 ? null : Number(event.target.value) })} placeholder="120000" /><small>Milliseconds. Use zero or blank to disable.</small></label>
				</div>
				{controller.advancedValidationError !== null && <small className="field-error connection-validation-error" role="alert">{controller.advancedValidationError}</small>}
			</div>
		</section>
	);
}
