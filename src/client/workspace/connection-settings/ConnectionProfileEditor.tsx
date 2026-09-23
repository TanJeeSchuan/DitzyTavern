import { Check, ChevronDown, KeyRound, RefreshCw, RotateCcw, Save, SlidersHorizontal, Zap } from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { Field } from "@/components/ui/field";
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
		discoveryPending,
		refreshModelsDisabledReason,
		setDraft,
		setCredentialDraft,
		setTestModelId,
		testDraft,
		refreshModels,
		applyDraft,
		updateCredential,
		resetCredential,
	} = controller;
	const updateDraft = (patch: Partial<ConnectionProfileDraft>) => setDraft({ ...draft, ...patch });
	const modelOptions = Array.from(new Set([...(selectedProfile?.discoveryCatalog ?? []), ...draft.pinnedModels]));
	const updateTestModel = (value: string) => {
		setTestModelId(value);
		updateDraft({ pinnedModels: value.length > 0 ? [value, ...draft.pinnedModels.slice(1)] : [] });
	};

	return (
		<section className="connection-editor-section">
			<div className="connection-editor-heading">
				<div>
					<h3>{selectedProfile ? `Edit ${selectedProfile.displayName}` : "New connection"}</h3>
					<span>{selectedProfile ? "Available to every Chat" : "Not saved yet"}</span>
				</div>
			</div>
			<div className="definition-form">
				<Field htmlFor="connection-display-name" label="Display name"><input id="connection-display-name" className="field-input" value={draft.displayName} onChange={(event) => updateDraft({ displayName: event.target.value })} /></Field>
				<Field label="Provider"><div className="field-input connection-provider-value">{draft.adapter === "deepseek" ? "DeepSeek" : draft.adapter === "openrouter" ? "OpenRouter" : "OpenAI Compatible"}</div></Field>
				<Field htmlFor="connection-credential" label="Credential" helper={credentialDraft.length > 0 && selectedProfile ? "Update this credential before testing it." : credentialDraft.length > 0 ? "The credential will be saved when this connection is created." : "Saved credentials cannot be viewed. Enter a new one to replace it."}>
					<div className="credential-field-row">
						<div className="credential-input-row"><KeyRound aria-hidden="true" /><input id="connection-credential" className="field-input" type="password" autoComplete="new-password" value={credentialDraft} onChange={(event) => setCredentialDraft(event.target.value)} placeholder={selectedProfile?.credentialConfigured ? "Configured; enter to replace" : "Enter API key"} /></div>
						{selectedProfile?.credentialConfigured && <button className="secondary-button" type="button" onClick={() => void resetCredential()}><RotateCcw aria-hidden="true" /> Reset</button>}
						{selectedProfile && credentialDraft.length > 0 && <button className="secondary-button" type="button" onClick={() => void updateCredential()}><KeyRound aria-hidden="true" /> Update credential</button>}
					</div>
				</Field>
				<Field htmlFor={`connection-model-${selectedProfileId ?? "new"}`} label="Default and test model" helper="Used for connection tests and saved as the default model.">
					<div className="connection-model-field-row">
						<div className="connection-model-picker">
							<input id={`connection-model-${selectedProfileId ?? "new"}`} className="field-input connection-model-input" value={testModelId} onChange={(event) => updateTestModel(event.target.value)} placeholder="deepseek-flash" />
							<DropdownMenu.Root>
								<DropdownMenu.Trigger asChild><button className="connection-model-menu-button" type="button" aria-label="Show available models" disabled={modelOptions.length === 0}><ChevronDown aria-hidden="true" /></button></DropdownMenu.Trigger>
								<DropdownMenu.Portal>
									<DropdownMenu.Content className="connection-model-menu-content" align="end" sideOffset={6}>
										{modelOptions.map((modelId) => <DropdownMenu.Item className="connection-model-menu-item" key={modelId} onSelect={() => updateTestModel(modelId)}><span>{modelId}</span>{modelId === testModelId && <Check aria-hidden="true" />}</DropdownMenu.Item>)}
									</DropdownMenu.Content>
								</DropdownMenu.Portal>
							</DropdownMenu.Root>
						</div>
						<span title={refreshModelsDisabledReason ?? (discoveryPending ? "Refreshing models" : "Refresh models")}>
							<button className="secondary-button connection-refresh-models-button" type="button" aria-label={discoveryPending ? "Refreshing models" : "Refresh models"} aria-busy={discoveryPending} disabled={refreshModelsDisabledReason !== undefined} onClick={() => void refreshModels()}><RefreshCw aria-hidden="true" /></button>
						</span>
					</div>
				</Field>

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
