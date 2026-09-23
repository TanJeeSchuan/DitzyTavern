import { KeyRound, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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

export function EmbeddingSettingsEditor({ onSaveStateChange }: { onSaveStateChange: (state: { dirty: boolean; pending: boolean; error: string | null; save: () => Promise<boolean> }) => void }) {
	const [state, setState] = useState<EditorState>(initialState);
	const [confirmingCredentialReset, setConfirmingCredentialReset] = useState(false);
	const saveRef = useRef<() => Promise<boolean>>(async () => false);
	const draftRef = useRef(state.draft);
	draftRef.current = state.draft;

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
		if (state.settings === null || state.draft === null) return false;
		const submitted = state.draft;
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
		let result: Awaited<ReturnType<typeof saveEmbeddingSettings>>;
		try { result = await saveEmbeddingSettings(command); }
		catch { setState((current) => ({ ...current, pending: false, error: "Embedding Settings could not be saved." })); return false; }
		if (result.outcome === "applied") {
			setState((current) => ({ settings: result.settings, draft: current.draft === submitted ? draftFromEmbeddingSettings(result.settings) : current.draft, loading: false, pending: false, notice: "Embedding Settings saved.", error: null }));
			return draftRef.current === submitted;
		} else if (result.outcome === "conflict") {
			setState((current) => ({ ...current, settings: result.currentSettings, pending: false, notice: "These settings changed elsewhere. Review your draft before saving again.", error: null }));
		} else {
			setState((current) => ({ ...current, pending: false, error: result.reason }));
		}
		return false;
	};
	const dirty = state.settings !== null && state.draft !== null && (state.draft.endpoint !== state.settings.endpoint || state.draft.model !== state.settings.model || state.draft.threshold !== state.settings.threshold || state.draft.deadlineMs !== state.settings.deadlineMs || state.draft.credential.length > 0);
	saveRef.current = apply;
	useEffect(() => { onSaveStateChange({ dirty, pending: state.pending, error: state.error, save: () => saveRef.current() }); }, [dirty, state.pending, state.error, onSaveStateChange]);

	const resetCredential = async () => {
		if (state.settings === null) return;
		setState((current) => ({ ...current, pending: true, notice: null, error: null }));
		const result = await saveEmbeddingSettings({ type: "reset-credential", expectedRevision: state.settings.revision, confirmed: true });
		if (result.outcome === "applied") {
			setState({ settings: result.settings, draft: draftFromEmbeddingSettings(result.settings), loading: false, pending: false, notice: "Embedding credential removed.", error: null });
		} else if (result.outcome === "conflict") {
			setState((current) => ({ ...current, settings: result.currentSettings, pending: false, notice: "These settings changed elsewhere. Review your draft before saving again.", error: null }));
		} else setState((current) => ({ ...current, pending: false, error: result.reason }));
	};

	if (state.loading) return <EmbeddingSettingsLoading />;
	if (state.draft === null || state.settings === null) return <section className="settings-section"><h3>Semantic Lore</h3><p className="settings-feedback-error" role="alert">{state.error ?? "Embedding Settings could not be loaded."}</p><Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>Try again</Button></section>;

	return <>
	<section className="settings-section embedding-settings-editor" aria-labelledby="embedding-settings-title">
		<div>
			<h3 id="embedding-settings-title">Semantic Lore</h3>
			<p>Use a separate OpenAI-compatible embedding service to match authored Semantic Triggers.</p>
		</div>
		<div className="embedding-settings-grid">
			<Field htmlFor="embedding-endpoint" label="Embedding endpoint" helper="HTTP or HTTPS. Leave empty to use keyword matching only."><input id="embedding-endpoint" className="field-input" type="url" value={state.draft.endpoint} onChange={(event) => updateDraft({ endpoint: event.target.value })} placeholder="https://localhost:11434/v1/embeddings" autoComplete="url" /></Field>
			<Field htmlFor="embedding-model" label="Model"><input id="embedding-model" className="field-input" value={state.draft.model} onChange={(event) => updateDraft({ model: event.target.value })} placeholder="text-embedding-3-small" autoComplete="off" /></Field>
			<Field htmlFor="embedding-threshold" label="Default cosine threshold" helper="Starts at 0.70. This is an uncalibrated starting point for the selected model."><input id="embedding-threshold" className="field-input" type="number" min="0" max="1" step="0.01" value={state.draft.threshold} onChange={(event) => updateDraft({ threshold: Number(event.target.value) })} /></Field>
			<Field htmlFor="embedding-deadline" label="Required-work deadline" helper="Milliseconds. Starts at 5,000."><input id="embedding-deadline" className="field-input" type="number" min="1" step="100" value={state.draft.deadlineMs} onChange={(event) => updateDraft({ deadlineMs: Number(event.target.value) })} /></Field>
			<Field htmlFor="embedding-credential" className="embedding-credential-field" label={<><KeyRound aria-hidden="true" /> Credential {state.settings.credentialConfigured ? <em>(configured)</em> : <em>(optional)</em>}</>} helper="Write-only. The saved value is never read back or included in prompt data."><input id="embedding-credential" className="field-input" type="password" value={state.draft.credential} onChange={(event) => updateDraft({ credential: event.target.value })} placeholder={state.settings.credentialConfigured ? "Leave unchanged" : "Enter a credential"} autoComplete="new-password" /></Field>
		</div>
		{state.settings.credentialConfigured && <div className="embedding-settings-actions"><Button type="button" size="sm" variant="outline" onClick={() => setConfirmingCredentialReset(true)} disabled={state.pending}><RotateCcw aria-hidden="true" /> Remove credential</Button></div>}
		{state.error !== null && <p className="settings-feedback-error" role="alert">{state.error}</p>}
		{state.notice !== null && <p className="settings-feedback" role="status">{state.notice}</p>}
	</section>
	<Dialog open={confirmingCredentialReset} onOpenChange={(open) => { if (!state.pending) setConfirmingCredentialReset(open); }}>
		<DialogContent showCloseButton={false} className="sm:max-w-sm">
			<DialogHeader>
				<DialogTitle>Remove saved credential?</DialogTitle>
				<DialogDescription>This removes the saved embedding credential. You can enter a new one later.</DialogDescription>
			</DialogHeader>
			<div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
				<Button type="button" variant="ghost" disabled={state.pending} onClick={() => setConfirmingCredentialReset(false)}>Keep credential</Button>
				<Button type="button" variant="destructive" disabled={state.pending} onClick={() => { setConfirmingCredentialReset(false); void resetCredential(); }}>Remove credential</Button>
			</div>
		</DialogContent>
	</Dialog>
	</>;
}

function EmbeddingSettingsLoading() {
	return <section className="settings-section embedding-settings-editor" aria-labelledby="embedding-settings-loading-title" aria-busy="true">
		<div>
			<h3 id="embedding-settings-loading-title">Semantic Lore</h3>
			<div className="h-4 w-3/4 animate-pulse rounded bg-muted/50" />
			<p className="sr-only" role="status">Loading embedding settings…</p>
		</div>
		<div className="embedding-settings-grid">
			{["Embedding endpoint", "Model", "Default cosine threshold", "Required-work deadline", "Credential"].map((label) => <div className="field" key={label}><span>{label}</span><div className="h-9 animate-pulse rounded-md bg-muted/50" /><div className="h-4 w-3/4 animate-pulse rounded bg-muted/50" /></div>)}
		</div>
		<div className="embedding-settings-actions"><div className="h-9 w-28 animate-pulse rounded-md bg-muted/50" /><div className="h-9 w-36 animate-pulse rounded-md bg-muted/50" /></div>
	</section>;
}
