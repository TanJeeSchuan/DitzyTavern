import { useState } from "react";
import { ChevronDown, ChevronLeft, CircleCheck, CircleX, Zap } from "lucide-react";
import { AppSelect } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { CONNECTION_ADAPTER_LABELS, type ConnectionProfileDraft, type TestConnectionResult } from "../../connection-settings";
import { SaveFooter } from "../../SaveFooter";
import { useSaveGuard, useSaveNavigation } from "../../SaveGuard";
import { CredentialField } from "./CredentialField";
import { HeaderEditor } from "./HeaderEditor";
import { ModelCombobox } from "./ModelCombobox";
import type { ConnectionSettingsController } from "./useConnectionSettingsController";

export function ConnectionProfileEditor({ controller }: { controller: ConnectionSettingsController }) {
	const navigate = useSaveNavigation();
	const [validationVisible, setValidationVisible] = useState(false);
	const {
		draft,
		selectedProfile,
		selectedProfileId,
		credentialDraft,
		headerEditorData,
		testModelId,
		testResult,
		testPending,
		discoveryPending,
		refreshModelsDisabledReason,
		resolvedRequestUrl,
		setDraft,
		setCredentialDraft,
		setHeaderEditorData,
		setTestModelId,
	} = controller;
	useSaveGuard({ dirty: controller.dirty, saving: controller.saving, save: controller.applyDraft, discard: controller.discardDraft });
	const updateDraft = (patch: Partial<ConnectionProfileDraft>) => setDraft({ ...draft, ...patch });
	const modelOptions = Array.from(new Set([...(selectedProfile?.discoveryCatalog ?? []), ...draft.pinnedModels]));
	const updateModel = (value: string) => {
		setTestModelId(value);
		updateDraft({ pinnedModels: value.length > 0 ? [value, ...draft.pinnedModels.slice(1)] : [] });
	};
	const decisions = draft.apiFormat === "system-one";
	const requiresTimeout = draft.apiFormat !== "chat-completions";
	const customEndpoint = requiresTimeout || draft.adapter === "openai-compatible";
	const endpointFields = <>
		<Field
			htmlFor="connection-request-url"
			label="Request URL"
			helper={resolvedRequestUrl === ""
				? "Add a trailing slash to a base URL. Without it, the URL is treated as the exact endpoint."
				: `Sends to ${resolvedRequestUrl}. Add a trailing slash to a base URL.`}
		>
			<input
				id="connection-request-url"
				className="field-input"
				value={draft.requestUrl}
				onChange={(event) => updateDraft({ requestUrl: event.target.value })}
				placeholder="https://example.com/v1/"
				autoComplete="url"
			/>
		</Field>
		<Field htmlFor="connection-models-url" label="Models URL" helper="Optional exact endpoint that lists model IDs for the picker.">
			<input
				id="connection-models-url"
				className="field-input"
				value={draft.modelsUrl}
				onChange={(event) => updateDraft({ modelsUrl: event.target.value })}
				placeholder="https://example.com/v1/models"
				autoComplete="url"
			/>
		</Field>
	</>;
	const provider = decisions ? "System One" : draft.apiFormat === "embeddings" ? "Embeddings" : CONNECTION_ADAPTER_LABELS[draft.adapter];
	const title = draft.displayName.trim() || "New connection";

	return (
		<>
			<div className="panel-body settings-panel-body" onBlur={(event) => { if (event.target.matches("input, textarea, [role='combobox']")) setValidationVisible(true); }}>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					className="-ml-2 mb-3 text-muted-foreground"
					onClick={() => navigate(controller.closeEditor)}
				>
					<ChevronLeft aria-hidden="true" /> Connections
				</Button>
				<div className="mb-6 grid gap-0.5">
					<h3 className="truncate text-base! font-semibold">{title}</h3>
					<p className="text-xs text-muted-foreground">{[title !== provider && provider, selectedProfile === undefined && "Not saved yet"].filter(Boolean).join(" · ")}</p>
				</div>

				<div className="grid gap-4">
					<Field htmlFor="connection-api-format" label="API Format">
						<AppSelect
							id="connection-api-format"
							className="field-input"
							value={draft.apiFormat}
							onValueChange={(value) => updateDraft({
								apiFormat: value === "system-one" || value === "embeddings" ? value : "chat-completions",
								timeoutMs: value === "system-one" ? 15000 : value === "embeddings" ? 5000 : 120000,
							})}
							options={[
								{ value: "chat-completions", label: "Chat Completions" },
								{ value: "embeddings", label: "Embeddings" },
								{ value: "system-one", label: "System One" },
							]}
						/>
					</Field>
					<Field htmlFor="connection-display-name" label="Name">
						<input
						id="connection-display-name"
						className="field-input"
						value={draft.displayName}
						onChange={(event) => updateDraft({ displayName: event.target.value })}
						placeholder="e.g. Local model"
						autoComplete="off"
					/>
					</Field>
					{customEndpoint && endpointFields}
					<CredentialField
						id="connection-credential"
						label="API key"
						value={credentialDraft}
						onChange={setCredentialDraft}
						configured={selectedProfile?.credentialConfigured ?? false}
						pending={controller.saving}
						onRemove={() => void controller.resetCredential()}
						placeholder="Enter API key"
					/>
					<Field htmlFor={`connection-model-${selectedProfileId ?? "new"}`} label="Default model" helper="Saved as the default model and used for connection tests.">
						<ModelCombobox
							id={`connection-model-${selectedProfileId ?? "new"}`}
							value={testModelId}
							options={modelOptions}
							onChange={updateModel}
							refreshDisabledReason={refreshModelsDisabledReason}
							refreshing={discoveryPending}
							onRefresh={() => void controller.refreshModels()}
						/>
					</Field>
					<div className="grid justify-items-start gap-2">
						<Button type="button" size="sm" variant="outline" disabled={testPending || !controller.canSave} onClick={() => void controller.testDraft()}>
							<Zap aria-hidden="true" /> {testPending ? "Testing…" : "Test connection"}
						</Button>
						{testResult !== null && <TestOutcome result={testResult} />}
						<small className="text-xs text-muted-foreground">Sends one real request, which the provider may bill. Doesn’t save.</small>
					</div>
				</div>

				<details className="group mt-8 border-t border-border pt-4">
					<summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
						<span className="text-[0.86rem] font-semibold">Advanced</span>
						<ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" aria-hidden="true" />
					</summary>
					<div className="mt-4 grid gap-4">
						{!customEndpoint && endpointFields}
						<Field label="Custom headers" helper="Saved values are never shown. Replace or remove them individually.">
							<HeaderEditor data={headerEditorData} onChange={setHeaderEditorData} />
						</Field>
						{!requiresTimeout && <>
						<Field htmlFor="connection-model-backend" label="Model backend">
							<AppSelect
							id="connection-model-backend"
							className="field-input"
							value={draft.modelBackend}
							onValueChange={(value) => updateDraft({ modelBackend: value === "ai-sdk" ? "ai-sdk" : "automatic" })}
							options={[
								{ value: "automatic", label: "Automatic" },
								{ value: "ai-sdk", label: "AI SDK" },
							]}
						/>
						</Field>
						<Field htmlFor="connection-adapter" label="AI SDK adapter">
							<AppSelect
							id="connection-adapter"
							className="field-input"
							value={draft.adapter}
							onValueChange={(value) => updateDraft({ adapter: value === "deepseek" || value === "openrouter" ? value : "openai-compatible" })}
							options={Object.entries(CONNECTION_ADAPTER_LABELS).map(([value, label]) => ({ value, label }))}
						/>
						</Field>
						<Field htmlFor="connection-output-token" label="Output limit field">
							<AppSelect
							id="connection-output-token"
							className="field-input"
							value={draft.outputTokenRepresentation}
							onValueChange={(value) => updateDraft({
								outputTokenRepresentation:
									value === "max_tokens" || value === "max_completion_tokens" || value === "omit" ? value : "automatic",
							})}
							options={[
								{ value: "automatic", label: "Automatic" },
								{ value: "max_tokens", label: "max_tokens" },
								{ value: "max_completion_tokens", label: "max_completion_tokens" },
								{ value: "omit", label: "Don’t send a limit" },
							]}
						/>
						</Field>
						</>}
						<div className="grid gap-1.5">
							<div className="flex items-center justify-between gap-3">
								<label htmlFor="connection-timeout" className="text-[13px] font-medium text-muted-foreground">{requiresTimeout ? "Request timeout" : "Stream inactivity timeout"}</label>
								<span className="flex items-center gap-2 text-xs text-muted-foreground">
									<span className="w-20">
								<input
									id="connection-timeout"
									className="field-input text-right tabular-nums"
									type="number"
									min="0"
									step="1"
									value={draft.timeoutMs === null ? "" : draft.timeoutMs / 1000}
									onChange={(event) => updateDraft({
										timeoutMs: event.target.value.length === 0 ? null : Math.round(Number(event.target.value) * 1000),
									})}
									placeholder={requiresTimeout ? "Required" : "Off"}
								/>
							</span>
									seconds
								</span>
							</div>
							<small className="text-xs text-muted-foreground">
					{requiresTimeout
						? "Abandons a request that takes longer than this."
						: "Aborts a stream that stays quiet this long. Blank or zero disables it."}
				</small>
						</div>
					</div>
				</details>
			</div>
			<SaveFooter
			dirty={controller.dirty}
			saving={controller.saving}
			error={controller.error ?? (validationVisible ? controller.validationError : null)}
			onSave={() => {
				setValidationVisible(true);
				if (controller.canSave) void controller.applyDraft();
			}}
		/>
		</>
	);
}

function TestOutcome({ result }: { result: TestConnectionResult }) {
	const passed = result.outcome === "success";
	const Icon = passed ? CircleCheck : CircleX;
	return (
		<p role="status" className={`flex items-start gap-1.5 text-xs ${passed ? "text-foreground" : "text-destructive"}`}>
			<Icon className={`mt-px size-3.5 shrink-0 ${passed ? "text-primary" : ""}`} aria-hidden="true" />
			{result.outcome === "invalid" ? result.reason : result.message}
		</p>
	);
}
