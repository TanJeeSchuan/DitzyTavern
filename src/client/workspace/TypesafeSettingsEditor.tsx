import { KeyRound, RotateCcw, Save } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { loadTypesafeSettings, saveTypesafeSettings, type TypesafeSettings } from "../typesafe-settings";
import type { TypesafeSettingsCommand } from "../../shared/contract/typesafe";
import { useAsyncEffect } from "../lib/use-async";

type Draft = { jevModel: string; loreTriggerMode: TypesafeSettings["loreTriggerMode"]; loreTriggerThreshold: number; credential: string };
type State = { settings: TypesafeSettings | null; draft: Draft; pending: boolean; error: string | null; notice: string | null };
const draftOf = (settings: TypesafeSettings): Draft => ({ jevModel: settings.jevModel, loreTriggerMode: settings.loreTriggerMode, loreTriggerThreshold: settings.loreTriggerThreshold, credential: "" });

export function TypesafeSettingsEditor() {
	const [state, setState] = useState<State>({ settings: null, draft: { jevModel: "jev-1.13.0", loreTriggerMode: "jev", loreTriggerThreshold: 0.5, credential: "" }, pending: false, error: null, notice: null });
	const [confirmReset, setConfirmReset] = useState(false);
	const applyLoaded = useCallback((settings: TypesafeSettings, notice: string | null = null) => setState({ settings, draft: draftOf(settings), pending: false, error: null, notice }), []);
	useAsyncEffect((cancelled) => {
		void loadTypesafeSettings().then((settings) => { if (!cancelled()) applyLoaded(settings); }).catch(() => { if (!cancelled()) setState((current) => ({ ...current, error: "Typesafe Settings could not be loaded." })); });
	}, [applyLoaded]);
	const update = (patch: Partial<Draft>) => setState((current) => ({ ...current, draft: { ...current.draft, ...patch }, error: null, notice: null }));
	const run = async (command: TypesafeSettingsCommand) => {
		setState((current) => ({ ...current, pending: true, error: null, notice: null }));
		const result = await saveTypesafeSettings(command);
		if (result.outcome === "applied") applyLoaded(result.settings, "Typesafe Settings saved.");
		else if (result.outcome === "conflict") setState((current) => ({ ...current, settings: result.currentSettings, pending: false, notice: "Typesafe Settings changed elsewhere. Review the current values before saving again." }));
		else setState((current) => ({ ...current, pending: false, error: result.reason }));
	};
	const { settings, draft } = state;
	const save = (revision: number) => {
		const command: Extract<TypesafeSettingsCommand, { type: "apply" }> = { type: "apply", expectedRevision: revision, jevModel: draft.jevModel, loreTriggerMode: draft.loreTriggerMode, loreTriggerThreshold: draft.loreTriggerThreshold };
		if (draft.credential.length > 0) command.credential = draft.credential;
		void run(command);
	};
	if (settings === null) return <section className="settings-section"><h3>Typesafe Jev</h3><p role={state.error ? "alert" : "status"}>{state.error ?? "Loading Typesafe Settings…"}</p></section>;
	return <>
		<section className="settings-section" aria-labelledby="typesafe-settings-title">
			<h3 id="typesafe-settings-title">Typesafe Jev</h3>
			<p>Jev judges Memory candidates and recall, and matches Lore Semantic Triggers.</p>
			<div className="embedding-settings-grid">
				<label className="field"><span>Jev model</span><input className="field-input" value={draft.jevModel} onChange={(event) => update({ jevModel: event.target.value })} autoComplete="off" /></label>
				<label className="field"><span>Lore Semantic Triggers</span><select className="field-input" value={draft.loreTriggerMode} onChange={(event) => update({ loreTriggerMode: event.target.value === "off" ? "off" : "jev" })}><option value="jev">Matched by Jev</option><option value="off">Off (Keywords only)</option></select></label>
				<label className="field"><span>Lore trigger threshold</span><input className="field-input" type="number" min="0" max="1" step="0.05" value={draft.loreTriggerThreshold} disabled={draft.loreTriggerMode === "off"} onChange={(event) => update({ loreTriggerThreshold: Number(event.target.value) })} /><small>From 0 to 1; starts at 0.5. A Semantic Trigger matches when Jev's probability reaches this value.</small></label>
				<label className="field embedding-credential-field"><span><KeyRound aria-hidden="true" /> Typesafe credential {settings.credentialConfigured ? <em>(configured)</em> : <em>(not configured)</em>}</span><input className="field-input" type="password" value={draft.credential} onChange={(event) => update({ credential: event.target.value })} placeholder={settings.credentialConfigured ? "Leave unchanged" : "Enter a credential"} autoComplete="new-password" /><small>Write-only. It is encrypted on the server and never returned to this form.</small></label>
			</div>
			<div className="embedding-settings-actions">
				<Button type="button" size="sm" disabled={state.pending} onClick={() => save(settings.revision)}><Save aria-hidden="true" /> Save Typesafe Settings</Button>
				{settings.credentialConfigured && <Button type="button" size="sm" variant="outline" disabled={state.pending} onClick={() => setConfirmReset(true)}><RotateCcw aria-hidden="true" /> Remove Typesafe credential</Button>}
			</div>
			{state.error && <p className="settings-feedback-error" role="alert">{state.error}</p>}{state.notice && <p className="settings-feedback" role="status">{state.notice}</p>}
		</section>
		<Dialog open={confirmReset} onOpenChange={(open) => { if (!state.pending) setConfirmReset(open); }}><DialogContent showCloseButton={false} className="sm:max-w-sm"><DialogHeader><DialogTitle>Remove Typesafe credential?</DialogTitle><DialogDescription>Memory processing pauses and Lore Semantic Triggers fall back to Keywords until a credential is saved again.</DialogDescription></DialogHeader><div className="flex flex-col gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="ghost" disabled={state.pending} onClick={() => setConfirmReset(false)}>Keep credential</Button><Button type="button" variant="destructive" disabled={state.pending} onClick={() => { setConfirmReset(false); void run({ type: "reset-credential", expectedRevision: settings.revision, confirmed: true }); }}>Remove credential</Button></div></DialogContent></Dialog>
	</>;
}
