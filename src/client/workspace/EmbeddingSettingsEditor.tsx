import { KeyRound, RotateCcw, Save } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	draftFromEmbeddingSettings,
	loadEmbeddingSettings,
	saveEmbeddingSettings,
	type EmbeddingSettings,
	type EmbeddingSettingsDraft,
} from "../embedding-settings";
import { useAsyncEffect } from "../lib/use-async";

type EditorState = {
	settings: EmbeddingSettings | null;
	draft: EmbeddingSettingsDraft | null;
	loading: boolean;
	pending: boolean;
	notice: string | null;
	error: string | null;
};

const initialState: EditorState = {
	settings: null,
	draft: null,
	loading: true,
	pending: false,
	notice: null,
	error: null,
};

export function EmbeddingSettingsEditor() {
	const [state, setState] = useState<EditorState>(initialState);

	const refresh = useCallback(async () => {
		setState((current) => ({ ...current, loading: true, error: null }));
		try {
			const settings = await loadEmbeddingSettings();
			setState({ settings, draft: draftFromEmbeddingSettings(settings), loading: false, pending: false, notice: null, error: null });
		} catch {
			setState((current) => ({ ...current, loading: false, error: "Embedding Settings could not be loaded." }));
		}
	}, []);

	useAsyncEffect((isCancelled) => {
		void loadEmbeddingSettings().then((settings) => {
			if (isCancelled()) return;
			setState({ settings, draft: draftFromEmbeddingSettings(settings), loading: false, pending: false, notice: null, error: null });
		}).catch(() => {
			if (isCancelled()) return;
			setState((current) => ({ ...current, loading: false, error: "Embedding Settings could not be loaded." }));
		});
	}, []);

	const updateDraft = (patch: Partial<EmbeddingSettingsDraft>) => setState((current) => current.draft === null ? current : { ...current, draft: { ...current.draft, ...patch }, notice: null, error: null });
	const apply = async () => {
		if (state.settings === null || state.draft === null) return;
		setState((current) => ({ ...current, pending: true, notice: null, error: null }));
		const command: Parameters<typeof saveEmbeddingSettings>[0] = {
			type: "apply" as const,
			expectedRevision: state.settings.revision,
			endpoint: state.draft.endpoint,
			model: state.draft.model,
			threshold: state.draft.threshold,
			deadlineMs: state.draft.deadlineMs,
		};
		if (state.draft.credential.length > 0) command.credential = state.draft.credential;
		const result = await saveEmbeddingSettings(command);
		if (result.outcome === "applied") {
			setState({ settings: result.settings, draft: draftFromEmbeddingSettings(result.settings), loading: false, pending: false, notice: "Embedding Settings saved.", error: null });
		} else if (result.outcome === "conflict") {
			setState((current) => ({ ...current, settings: result.currentSettings, pending: false, notice: "These settings changed elsewhere. Review your draft before saving again.", error: null }));
		} else {
			setState((current) => ({ ...current, pending: false, error: result.reason }));
		}
	};

	const resetCredential = async () => {
		if (state.settings === null) return;
		if (!window.confirm("Remove the saved embedding credential?")) return;
		setState((current) => ({ ...current, pending: true, notice: null, error: null }));
		const result = await saveEmbeddingSettings({ type: "reset-credential", expectedRevision: state.settings.revision, confirmed: true });
		if (result.outcome === "applied") {
			setState({ settings: result.settings, draft: draftFromEmbeddingSettings(result.settings), loading: false, pending: false, notice: "Embedding credential removed.", error: null });
		} else if (result.outcome === "conflict") {
			setState((current) => ({ ...current, settings: result.currentSettings, pending: false, notice: "These settings changed elsewhere. Review your draft before saving again.", error: null }));
		} else setState((current) => ({ ...current, pending: false, error: result.reason }));
	};

	if (state.loading) return <section className="settings-section"><h3>Semantic Lore</h3><p>Loading embedding settings…</p></section>;
	if (state.draft === null || state.settings === null) return <section className="settings-section"><h3>Semantic Lore</h3><p className="settings-feedback-error" role="alert">{state.error ?? "Embedding Settings could not be loaded."}</p><Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>Try again</Button></section>;

	return <section className="settings-section embedding-settings-editor" aria-labelledby="embedding-settings-title">
		<div>
			<h3 id="embedding-settings-title">Semantic Lore</h3>
			<p>Use a separate OpenAI-compatible embedding service to match authored Semantic Triggers.</p>
		</div>
		<div className="embedding-settings-grid">
			<label className="field"><span>Embedding endpoint</span><input className="field-input" type="url" value={state.draft.endpoint} onChange={(event) => updateDraft({ endpoint: event.target.value })} placeholder="https://localhost:11434/v1/embeddings" autoComplete="url" /><small>HTTP or HTTPS. Leave empty to use keyword matching only.</small></label>
			<label className="field"><span>Model</span><input className="field-input" value={state.draft.model} onChange={(event) => updateDraft({ model: event.target.value })} placeholder="text-embedding-3-small" autoComplete="off" /></label>
			<label className="field"><span>Default cosine threshold</span><input className="field-input" type="number" min="0" max="1" step="0.01" value={state.draft.threshold} onChange={(event) => updateDraft({ threshold: Number(event.target.value) })} /><small>Starts at 0.70. This is an uncalibrated starting point for the selected model.</small></label>
			<label className="field"><span>Required-work deadline</span><input className="field-input" type="number" min="1" step="100" value={state.draft.deadlineMs} onChange={(event) => updateDraft({ deadlineMs: Number(event.target.value) })} /><small>Milliseconds. Starts at 5,000.</small></label>
			<label className="field embedding-credential-field"><span><KeyRound aria-hidden="true" /> Credential {state.settings.credentialConfigured ? <em>(configured)</em> : <em>(optional)</em>}</span><input className="field-input" type="password" value={state.draft.credential} onChange={(event) => updateDraft({ credential: event.target.value })} placeholder={state.settings.credentialConfigured ? "Leave unchanged" : "Enter a credential"} autoComplete="new-password" /><small>Write-only. The saved value is never read back or included in prompt data.</small></label>
		</div>
		<div className="embedding-settings-actions"><Button type="button" size="sm" onClick={() => void apply()} disabled={state.pending}><Save aria-hidden="true" /> Save settings</Button>{state.settings.credentialConfigured && <Button type="button" size="sm" variant="outline" onClick={() => void resetCredential()} disabled={state.pending}><RotateCcw aria-hidden="true" /> Remove credential</Button>}</div>
		{state.error !== null && <p className="settings-feedback-error" role="alert">{state.error}</p>}
		{state.notice !== null && <p className="settings-feedback" role="status">{state.notice}</p>}
	</section>;
}
