import { Save } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { loadConnectionSettings, type ConnectionProfile } from "../connection-settings";
import { loadMemorySettings, saveMemorySettings, type MemorySettings } from "../memory-settings";
import type { MemorySettingsCommand } from "../../shared/contract/memory-settings";
import { useAsyncEffect } from "../lib/use-async";

type State = { settings: MemorySettings | null; profiles: ConnectionProfile[]; draft: { extractionProfileId: number | null; extractionModel: string; contextLimit: number; outputReserve: number; safetyAllowance: number; usefulnessConfidenceGate: number; recallRelevanceMinimum: number }; loading: boolean; pending: boolean; error: string | null; notice: string | null };
const emptyDraft = { extractionProfileId: null, extractionModel: "", contextLimit: 16384, outputReserve: 2048, safetyAllowance: 500, usefulnessConfidenceGate: 0.3, recallRelevanceMinimum: 1.5 };
const initial: State = { settings: null, profiles: [], draft: emptyDraft, loading: true, pending: false, error: null, notice: null };

export function MemorySettingsEditor() {
	const [state, setState] = useState<State>(initial);
	const applyLoaded = useCallback((settings: MemorySettings, profiles: ConnectionProfile[]) => setState({
		settings, profiles, draft: { extractionProfileId: settings.extractionProfileId, extractionModel: settings.extractionModel, contextLimit: settings.contextLimit, outputReserve: settings.outputReserve, safetyAllowance: settings.safetyAllowance, usefulnessConfidenceGate: settings.usefulnessConfidenceGate, recallRelevanceMinimum: settings.recallRelevanceMinimum }, loading: false, pending: false, error: null, notice: null,
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
	const save = async (command: MemorySettingsCommand, applied: (settings: MemorySettings) => void) => {
		setState((current) => ({ ...current, pending: true, error: null, notice: null }));
		const result = await saveMemorySettings(command);
		if (result.outcome === "applied") applied(result.settings);
		else if (result.outcome === "conflict") setState((current) => ({ ...current, settings: result.currentSettings, pending: false, notice: "Memory Settings changed elsewhere. Review the current values before saving again." }));
		else setState((current) => ({ ...current, pending: false, error: result.reason }));
	};
	const submit = () => state.settings && save({ expectedRevision: state.settings.revision, enabled: state.settings.enabled, ...state.draft }, (settings) => applyLoaded(settings, state.profiles));
	const toggle = (enabled: boolean) => {
		if (!state.settings) return;
		const { revision, ...saved } = state.settings;
		return save({ ...saved, expectedRevision: revision, enabled }, (settings) => setState((current) => ({ ...current, settings, pending: false })));
	};
	if (state.loading) return <section className="settings-section" aria-busy="true"><h3>Conversation Memory</h3><p role="status">Loading Memory Settings…</p></section>;
	const selectedProfile = state.profiles.find((profile) => profile.id === state.draft.extractionProfileId);
	const deletedProfile = state.settings !== null && state.settings.extractionProfileId !== null && !state.profiles.some((profile) => profile.id === state.settings?.extractionProfileId);
	const incomplete = !selectedProfile || !state.draft.extractionModel.trim() || !selectedProfile.credentialConfigured;
	return (
		<section className="settings-section" aria-labelledby="memory-settings-title">
			<div className="flex items-center justify-between gap-3">
				<h3 id="memory-settings-title">Conversation Memory</h3>
				{state.settings && <Switch checked={state.settings.enabled} disabled={state.pending} aria-label={state.settings.enabled ? "Turn off Memory" : "Turn on Memory"} onCheckedChange={(enabled) => void toggle(enabled)} />}
			</div>
			{state.settings?.enabled === false && <p className="settings-feedback" role="status">Memory is off. No Memories are recalled into prompts and no new Memories are extracted.</p>}
				<p>Extraction runs separately from writing generations. Profile transport and authentication stay in Connection Profiles; this form does not probe paid services.</p>
				{deletedProfile && <p className="settings-feedback-error" role="alert">The saved extraction Connection Profile no longer exists. Choose an available profile.</p>}
				{incomplete && <p className="settings-feedback" role="status">Memory processing is not ready. Configure an extraction profile and model, its profile credential, and the Typesafe credential in Model Settings.</p>}
				{state.error && !state.settings && <div className="settings-feedback-error" role="alert"><p>{state.error}</p><Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>Try again</Button></div>}
			<div className="embedding-settings-grid">
				<label className="field"><span>Extraction Connection Profile</span><select className="field-input" value={state.draft.extractionProfileId ?? ""} onChange={(event) => update({ extractionProfileId: event.target.value ? Number(event.target.value) : null })}><option value="">Choose a profile</option>{state.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.displayName}{profile.credentialConfigured ? " · credential configured" : " · no credential"}</option>)}</select></label>
				<label className="field"><span>Extraction model</span><input className="field-input" value={state.draft.extractionModel} onChange={(event) => update({ extractionModel: event.target.value })} placeholder="Provider model ID" autoComplete="off" /></label>
				<label className="field"><span>Extraction context limit</span><input className="field-input" type="number" min="1" step="1" value={state.draft.contextLimit} onChange={(event) => update({ contextLimit: Number(event.target.value) })} /><small>Estimated tokens; starts at 16,384.</small></label>
				<label className="field"><span>Extraction output reserve</span><input className="field-input" type="number" min="1" step="1" value={state.draft.outputReserve} onChange={(event) => update({ outputReserve: Number(event.target.value) })} /><small>Estimated tokens; starts at 2,048.</small></label>
				<label className="field"><span>Safety allowance</span><input className="field-input" type="number" min="0" step="1" value={state.draft.safetyAllowance} onChange={(event) => update({ safetyAllowance: Number(event.target.value) })} /><small>Estimated tokens; starts at 500.</small></label>
				<label className="field"><span>Usefulness confidence gate</span><input className="field-input" type="number" min="0" max="1" step="0.05" value={state.draft.usefulnessConfidenceGate} onChange={(event) => update({ usefulnessConfidenceGate: Number(event.target.value) })} /><small>From 0 to 1; starts at 0.3. Keeps a Memory only when Jev chooses retain with at least this confidence.</small></label>
				<label className="field"><span>Recall relevance minimum</span><input className="field-input" type="number" min="0" max="3" step="0.25" value={state.draft.recallRelevanceMinimum} onChange={(event) => update({ recallRelevanceMinimum: Number(event.target.value) })} /><small>From 0 (irrelevant) to 3 (central); starts at 1.5. A recalled Memory needs at least this Jev relevance score for a Generation.</small></label>
			</div>
			<div className="embedding-settings-actions"><Button type="button" size="sm" onClick={() => void submit()} disabled={state.pending}><Save aria-hidden="true" /> Save settings</Button></div>
			{state.error && <p className="settings-feedback-error" role="alert">{state.error}</p>}{state.notice && <p className="settings-feedback" role="status">{state.notice}</p>}
		</section>
	);
}
