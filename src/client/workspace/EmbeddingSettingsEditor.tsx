import { ChevronLeft, CircleCheck, CircleX, Zap } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import {
	draftFromEmbeddingSettings,
	loadEmbeddingSettings,
	refreshEmbeddingModels,
	saveEmbeddingSettings,
	testEmbeddingSettings,
	type EmbeddingSettings,
	type EmbeddingSettingsDraft,
	type EmbeddingSettingsResult,
	type EmbeddingTestResult,
} from "../embedding-settings";
import { useAsyncEffect } from "../lib/use-async";
import { SaveFooter } from "../SaveFooter";
import { useSaveGuard, useSaveNavigation } from "../SaveGuard";
import { CredentialField } from "./connection-settings/CredentialField";
import { ModelCombobox } from "./connection-settings/ModelCombobox";

type EmbeddingState = {
	settings: EmbeddingSettings | null;
	draft: EmbeddingSettingsDraft | null;
	loading: boolean;
	pending: boolean;
	discoveryPending: boolean;
	testPending: boolean;
	testResult: EmbeddingTestResult | null;
	modelCatalog: string[];
	error: string | null;
};

const CONFLICT_ERROR = "These settings changed elsewhere. Review your draft before saving again.";

export type EmbeddingSettingsController = ReturnType<typeof useEmbeddingSettings>;

export function useEmbeddingSettings() {
	const [state, setState] = useState<EmbeddingState>({ settings: null, draft: null, loading: true, pending: false, discoveryPending: false, testPending: false, testResult: null, modelCatalog: [], error: null });
	const loaded = (settings: EmbeddingSettings): EmbeddingState => ({ settings, draft: draftFromEmbeddingSettings(settings), loading: false, pending: false, discoveryPending: false, testPending: false, testResult: null, modelCatalog: settings.model.length > 0 ? [settings.model] : [], error: null });

	const load = useCallback((isCancelled: () => boolean = () => false) => loadEmbeddingSettings()
		.then((settings) => { if (!isCancelled()) setState(loaded(settings)); })
		.catch(() => { if (!isCancelled()) setState((current) => ({ ...current, loading: false, error: "Embedding Settings could not be loaded." })); }), []);
	useAsyncEffect((isCancelled) => { void load(isCancelled); }, [load]);

	const settle = (result: EmbeddingSettingsResult, keepDraft: (draft: EmbeddingSettingsDraft | null) => boolean) => {
		if (result.outcome === "applied") setState((current) => ({ ...loaded(result.settings), draft: keepDraft(current.draft) ? current.draft : draftFromEmbeddingSettings(result.settings) }));
		else if (result.outcome === "conflict") setState((current) => ({ ...current, settings: result.currentSettings, pending: false, error: CONFLICT_ERROR }));
		else setState((current) => ({ ...current, pending: false, error: result.reason }));
		return result.outcome === "applied";
	};

	const { settings, draft } = state;
	const dirty = settings !== null && draft !== null && (draft.endpoint !== settings.endpoint || draft.model !== settings.model || draft.deadlineMs !== settings.deadlineMs || draft.credential.length > 0);

	const save = async () => {
		if (settings === null || draft === null) return false;
		setState((current) => ({ ...current, pending: true, error: null }));
		const { credential, ...fields } = draft;
		const command: Parameters<typeof saveEmbeddingSettings>[0] = { type: "apply", expectedRevision: settings.revision, ...fields };
		if (credential.length > 0) command.credential = credential;
		const result = await saveEmbeddingSettings(command);
		return settle(result, (current) => current !== draft);
	};

	const removeCredential = async () => {
		if (settings === null) return;
		setState((current) => ({ ...current, pending: true, error: null }));
		settle(await saveEmbeddingSettings({ type: "reset-credential", expectedRevision: settings.revision, confirmed: true }), () => true);
	};

	const refreshModels = async () => {
		setState((current) => ({ ...current, discoveryPending: true, error: null }));
		try {
			const result = await refreshEmbeddingModels();
			setState((current) => result.outcome === "success"
				? { ...current, discoveryPending: false, modelCatalog: Array.from(new Set([...result.catalog, current.draft?.model ?? ""])).filter(Boolean) }
				: { ...current, discoveryPending: false, error: result.message });
		} catch {
			setState((current) => ({ ...current, discoveryPending: false, error: "Model catalog refresh could not be completed." }));
		}
	};

	const test = async () => {
		if (draft === null) return;
		setState((current) => ({ ...current, testPending: true, testResult: null, error: null }));
		try {
			const result = await testEmbeddingSettings({ endpoint: draft.endpoint, model: draft.model, deadlineMs: draft.deadlineMs, ...(draft.credential.length > 0 && { credential: draft.credential }) });
			setState((current) => ({ ...current, testPending: false, testResult: result }));
		} catch {
			setState((current) => ({ ...current, testPending: false, testResult: { outcome: "failure", kind: "endpoint", message: "Embedding service test could not be completed." } }));
		}
	};

	return {
		...state,
		dirty,
		reload: () => { setState((current) => ({ ...current, loading: true, error: null })); void load(); },
		update: (patch: Partial<EmbeddingSettingsDraft>) => setState((current) => current.draft === null ? current : { ...current, draft: { ...current.draft, ...patch }, error: null }),
		discard: () => setState((current) => current.settings === null ? current : { ...current, draft: draftFromEmbeddingSettings(current.settings), error: null }),
		save,
		removeCredential,
		refreshModels,
		test,
	};
}

export function EmbeddingSettingsEditor({ embedding, onBack }: { embedding: EmbeddingSettingsController; onBack: () => void }) {
	const navigate = useSaveNavigation();
	useSaveGuard({ dirty: embedding.dirty, saving: embedding.pending, save: embedding.save, discard: embedding.discard });
	const { settings, draft } = embedding;
	const refreshModelsDisabledReason = settings === null || draft === null || settings.endpoint.length === 0
		? "Save an embedding endpoint before refreshing."
		: draft.endpoint.trim() !== settings.endpoint
			? "Save the embedding endpoint before refreshing."
			: draft.credential.length > 0
				? "Save the API key before refreshing."
				: embedding.discoveryPending
					? "A model refresh is already in progress."
					: undefined;
	return (
		<>
			<div className="panel-body settings-panel-body">
				<Button type="button" size="sm" variant="ghost" className="-ml-2 mb-3 text-muted-foreground" onClick={() => navigate(onBack)}><ChevronLeft aria-hidden="true" /> Connections</Button>
				<section aria-labelledby="embedding-settings-title">
					<h3 id="embedding-settings-title" className="text-base! font-semibold">Memory recall embeddings</h3>
					<p>An OpenAI-compatible embedding service shortlists saved Memories for recall.</p>
					{settings === null || draft === null ? (
						<div className="grid justify-items-start gap-2">
							<p className="text-xs text-destructive" role="alert">{embedding.error ?? "Embedding Settings could not be loaded."}</p>
							<Button type="button" size="sm" variant="outline" onClick={embedding.reload}>Try again</Button>
						</div>
					) : (
						<div className="grid gap-4">
							<Field htmlFor="embedding-endpoint" label="Endpoint" helper="Leave empty to turn off Memory indexing and recall.">
								<input id="embedding-endpoint" className="field-input" type="url" value={draft.endpoint} onChange={(event) => embedding.update({ endpoint: event.target.value })} placeholder="http://localhost:11434/v1/embeddings" autoComplete="url" />
							</Field>
							<Field htmlFor="embedding-model" label="Model">
								<ModelCombobox
									id="embedding-model"
									value={draft.model}
									options={embedding.modelCatalog}
									onChange={(model) => embedding.update({ model })}
									refreshDisabledReason={refreshModelsDisabledReason}
									refreshing={embedding.discoveryPending}
									onRefresh={() => void embedding.refreshModels()}
								/>
							</Field>
							<CredentialField
								id="embedding-credential"
								label="API key"
								value={draft.credential}
								onChange={(credential) => embedding.update({ credential })}
								configured={settings.credentialConfigured}
								pending={embedding.pending}
								onRemove={() => void embedding.removeCredential()}
								placeholder="Optional"
							/>
							<div className="grid gap-1.5">
								<div className="flex items-center justify-between gap-3">
									<label htmlFor="embedding-deadline" className="text-[13px] font-medium text-muted-foreground">Deadline</label>
									<span className="flex items-center gap-2 text-xs text-muted-foreground">
										<span className="w-20"><input id="embedding-deadline" className="field-input text-right tabular-nums" type="number" min="0.1" step="0.5" value={draft.deadlineMs / 1000} onChange={(event) => embedding.update({ deadlineMs: Math.round(Number(event.target.value) * 1000) })} /></span>
										seconds
									</span>
								</div>
								<small className="text-xs text-muted-foreground">How long Memory indexing and recall wait for embeddings.</small>
							</div>
							<div className="grid justify-items-start gap-2">
								<Button type="button" size="sm" variant="outline" disabled={embedding.testPending || draft.endpoint.trim().length === 0 || draft.model.trim().length === 0} onClick={() => void embedding.test()}>
									<Zap aria-hidden="true" /> {embedding.testPending ? "Testing…" : "Test embeddings"}
								</Button>
								{embedding.testResult !== null && <TestOutcome result={embedding.testResult} />}
								<small className="text-xs text-muted-foreground">Sends one real embedding request, which the provider may bill. Doesn’t save.</small>
							</div>
						</div>
					)}
				</section>
			</div>
			<SaveFooter dirty={embedding.dirty} saving={embedding.pending} error={embedding.error} onSave={() => void embedding.save()} />
		</>
	);
}

function TestOutcome({ result }: { result: EmbeddingTestResult }) {
	const passed = result.outcome === "success";
	const Icon = passed ? CircleCheck : CircleX;
	return (
		<p role="status" className={`flex items-start gap-1.5 text-xs ${passed ? "text-foreground" : "text-destructive"}`}>
			<Icon className={`mt-px size-3.5 shrink-0 ${passed ? "text-primary" : ""}`} aria-hidden="true" />
			{result.outcome === "success" ? `Received a ${result.dimensions.toLocaleString()}-dimension vector.` : result.outcome === "invalid" ? result.reason : result.message}
		</p>
	);
}
