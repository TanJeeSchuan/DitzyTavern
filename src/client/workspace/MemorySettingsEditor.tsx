import { KeyRound, RotateCcw, Save } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { loadConnectionSettings, type ConnectionProfile } from "../connection-settings";
import { loadMemorySettings, saveMemorySettings, type MemorySettings } from "../memory-settings";
import type { MemorySettingsCommand } from "../../shared/contract/memory-settings";
import { useAsyncEffect } from "../lib/use-async";

type State = { settings: MemorySettings | null; profiles: ConnectionProfile[]; draft: { extractionProfileId: number | null; extractionModel: string; contextLimit: number; outputReserve: number; safetyAllowance: number; jevModel: string; usefulnessConfidenceGate: number; credential: string }; loading: boolean; pending: boolean; error: string | null; notice: string | null };
const emptyDraft = { extractionProfileId: null, extractionModel: "", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, jevModel: "jev-1.13.0", usefulnessConfidenceGate: 0.3, credential: "" };
const initial: State = { settings: null, profiles: [], draft: emptyDraft, loading: true, pending: false, error: null, notice: null };

export function MemorySettingsEditor() {
	const [state, setState] = useState<State>(initial);
	const [confirmReset, setConfirmReset] = useState(false);
	const applyLoaded = useCallback((settings: MemorySettings, profiles: ConnectionProfile[]) => setState({
		settings, profiles, draft: { extractionProfileId: settings.extractionProfileId, extractionModel: settings.extractionModel, contextLimit: settings.contextLimit, outputReserve: settings.outputReserve, safetyAllowance: settings.safetyAllowance, jevModel: settings.jevModel, usefulnessConfidenceGate: settings.usefulnessConfidenceGate, credential: "" }, loading: false, pending: false, error: null, notice: null,
	}), []);
	const refresh = useCallback(async () => {
		setState((current) => ({ ...current, loading: true, error: null }));
		try { const [settings, connections] = await Promise.all([loadMemorySettings(), loadConnectionSettings()]); applyLoaded(settings, connections.profiles); }
		catch { setState((current) => ({ ...current, loading: false, error: "Memory Settings could not be loaded." })); }
	}, [applyLoaded]);
	useAsyncEffect((cancelled) => {
		void Promise.all([loadMemorySettings(), loadConnectionSettings()]).then(([settings, connections]) => { if (!cancelled()) applyLoaded(settings, connections.profiles); }).catch(() => { if (!cancelled()) setState((current) => ({ ...current, loading: false, error: "Memory Settings could not be loaded." })); });
	}, [applyLoaded]);
	const update = (patch: Partial<State["draft"]>) => setState((current) => ({ ...current, draft: { ...current.draft, ...patch }, error: null, notice: null }));
	const submit = async () => {
		if (!state.settings) return;
		setState((current) => ({ ...current, pending: true, error: null, notice: null }));
		const command: Extract<MemorySettingsCommand, { type: "apply" }> = { type: "apply", expectedRevision: state.settings.revision, extractionProfileId: state.draft.extractionProfileId, extractionModel: state.draft.extractionModel, contextLimit: state.draft.contextLimit, outputReserve: state.draft.outputReserve, safetyAllowance: state.draft.safetyAllowance, jevModel: state.draft.jevModel, usefulnessConfidenceGate: state.draft.usefulnessConfidenceGate };
		if (state.draft.credential.length > 0) command.credential = state.draft.credential;
		const result = await saveMemorySettings(command);
		if (result.outcome === "applied") applyLoaded(result.settings, state.profiles);
		else if (result.outcome === "conflict") setState((current) => ({ ...current, settings: result.currentSettings, pending: false, notice: "Memory Settings changed elsewhere. Review the current values before saving again." }));
		else setState((current) => ({ ...current, pending: false, error: result.reason }));
	};
	const resetCredential = async () => {
		if (!state.settings) return;
		const result = await saveMemorySettings({ type: "reset-credential", expectedRevision: state.settings.revision, confirmed: true });
		setConfirmReset(false);
		if (result.outcome === "applied") applyLoaded(result.settings, state.profiles);
		else if (result.outcome === "conflict") setState((current) => ({ ...current, settings: result.currentSettings, pending: false, notice: "Memory Settings changed elsewhere. Review the current values before saving again." }));
		else setState((current) => ({ ...current, pending: false, error: result.reason }));
	};
	if (state.loading) return <section className="settings-section" aria-busy="true"><h3>Conversation Memory</h3><p role="status">Loading Memory Settings…</p></section>;
	const selectedProfile = state.profiles.find((profile) => profile.id === state.draft.extractionProfileId);
	const deletedProfile = state.settings !== null && state.settings.extractionProfileId !== null && !state.profiles.some((profile) => profile.id === state.settings?.extractionProfileId);
	const incomplete = !selectedProfile || !state.draft.extractionModel.trim() || !selectedProfile.credentialConfigured || !state.settings?.credentialConfigured;
	return <>
		<section className="settings-section" aria-labelledby="memory-settings-title">
			<h3 id="memory-settings-title">Conversation Memory</h3>
				<p>Extraction runs separately from writing generations. Profile transport and authentication stay in Connection Profiles; this form does not probe paid services.</p>
				{deletedProfile && <p className="settings-feedback-error" role="alert">The saved extraction Connection Profile no longer exists. Choose an available profile.</p>}
				{incomplete && <p className="settings-feedback" role="status">Memory processing is not ready. Configure an extraction profile and model, its profile credential, and the Typesafe credential.</p>}
				{state.error && !state.settings && <div className="settings-feedback-error" role="alert"><p>{state.error}</p><Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>Try again</Button></div>}
			<div className="embedding-settings-grid">
				<label className="field"><span>Extraction Connection Profile</span><select className="field-input" value={state.draft.extractionProfileId ?? ""} onChange={(event) => update({ extractionProfileId: event.target.value ? Number(event.target.value) : null })}><option value="">Choose a profile</option>{state.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}{profile.credentialConfigured ? " · credential configured" : " · no credential"}</option>)}</select></label>
				<label className="field"><span>Extraction model</span><input className="field-input" value={state.draft.extractionModel} onChange={(event) => update({ extractionModel: event.target.value })} placeholder="Provider model ID" autoComplete="off" /></label>
				<label className="field"><span>Extraction context limit</span><input className="field-input" type="number" min="1" step="1" value={state.draft.contextLimit} onChange={(event) => update({ contextLimit: Number(event.target.value) })} /><small>Estimated tokens; starts at 16,384.</small></label>
				<label className="field"><span>Extraction output reserve</span><input className="field-input" type="number" min="1" step="1" value={state.draft.outputReserve} onChange={(event) => update({ outputReserve: Number(event.target.value) })} /><small>Estimated tokens; starts at 2,048.</small></label>
				<label className="field"><span>Safety allowance</span><input className="field-input" type="number" min="0" step="1" value={state.draft.safetyAllowance} onChange={(event) => update({ safetyAllowance: Number(event.target.value) })} /><small>Estimated tokens; starts at 500.</small></label>
				<label className="field"><span>Typesafe Jev model</span><input className="field-input" value={state.draft.jevModel} onChange={(event) => update({ jevModel: event.target.value })} /></label>
				<label className="field"><span>Usefulness confidence gate</span><input className="field-input" type="number" min="0" max="1" step="0.05" value={state.draft.usefulnessConfidenceGate} onChange={(event) => update({ usefulnessConfidenceGate: Number(event.target.value) })} /><small>From 0 to 1; starts at 0.3. Keeps a Memory only when Jev chooses retain with at least this confidence.</small></label>
				<label className="field embedding-credential-field"><span><KeyRound aria-hidden="true" /> Typesafe credential {state.settings?.credentialConfigured ? <em>(configured)</em> : <em>(not configured)</em>}</span><input className="field-input" type="password" value={state.draft.credential} onChange={(event) => update({ credential: event.target.value })} placeholder={state.settings?.credentialConfigured ? "Leave unchanged" : "Enter a credential"} autoComplete="new-password" /><small>Write-only. It is encrypted on the server and never returned to this form.</small></label>
			</div>
			<div className="embedding-settings-actions"><Button type="button" size="sm" onClick={() => void submit()} disabled={state.pending}><Save aria-hidden="true" /> Save settings</Button>{state.settings?.credentialConfigured && <Button type="button" size="sm" variant="outline" onClick={() => setConfirmReset(true)} disabled={state.pending}><RotateCcw aria-hidden="true" /> Remove Typesafe credential</Button>}</div>
			{state.error && <p className="settings-feedback-error" role="alert">{state.error}</p>}{state.notice && <p className="settings-feedback" role="status">{state.notice}</p>}
		</section>
		<Dialog open={confirmReset} onOpenChange={(open) => { if (!state.pending) setConfirmReset(open); }}><DialogContent showCloseButton={false} className="sm:max-w-sm"><DialogHeader><DialogTitle>Remove Typesafe credential?</DialogTitle><DialogDescription>This pauses Memory processing until a Typesafe credential is saved again.</DialogDescription></DialogHeader><div className="flex flex-col gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="ghost" disabled={state.pending} onClick={() => setConfirmReset(false)}>Keep credential</Button><Button type="button" variant="destructive" disabled={state.pending} onClick={() => { setState((current) => ({ ...current, pending: true })); void resetCredential(); }}>Remove credential</Button></div></DialogContent></Dialog>
	</>;
}
