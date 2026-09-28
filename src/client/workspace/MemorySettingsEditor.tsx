import { ChevronsUpDown } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { isChatProfile, isEmbeddingsProfile, loadConnectionSettings, type ConnectionProfile, type ConnectionSettings } from "../connection-settings";
import { loadMemorySettings, saveMemorySettings, type MemorySettings } from "../memory-settings";
import type { MemorySettingsCommand } from "../../shared/contract/memory-settings";
import { useAsyncEffect } from "../lib/use-async";
import { ProfileModelPicker } from "../ProfileModelPicker";
import { SaveFooter } from "../SaveFooter";
import { useSaveGuard } from "../SaveGuard";

type Draft = Omit<MemorySettings, "revision" | "enabled">;
type State = { settings: MemorySettings | null; connections: ConnectionSettings | null; draft: Draft | null; loading: boolean; pending: boolean; error: string | null; notice: string | null };
const initial: State = { settings: null, connections: null, draft: null, loading: true, pending: false, error: null, notice: null };
const draftOf = ({ revision: _revision, enabled: _enabled, ...draft }: MemorySettings): Draft => draft;

export function MemorySettingsEditor() {
	const [state, setState] = useState<State>(initial);
	const applyLoaded = useCallback((settings: MemorySettings, connections: ConnectionSettings | null) => setState({
		settings, connections, draft: draftOf(settings), loading: false, pending: false, error: null, notice: null,
	}), []);
	const load = useCallback(() => Promise.all([loadMemorySettings(), loadConnectionSettings()]), []);
	const refresh = useCallback(async () => {
		setState((current) => ({ ...current, loading: true, error: null }));
		try { const [settings, connections] = await load(); applyLoaded(settings, connections); }
		catch { setState((current) => ({ ...current, loading: false, error: "Memory Settings could not be loaded." })); }
	}, [applyLoaded, load]);
	useAsyncEffect((cancelled) => {
		void load().then(([settings, connections]) => { if (!cancelled()) applyLoaded(settings, connections); }).catch(() => { if (!cancelled()) setState((current) => ({ ...current, loading: false, error: "Memory Settings could not be loaded." })); });
	}, [applyLoaded, load]);
	const update = (patch: Partial<Draft>) => setState((current) => current.draft === null ? current : ({ ...current, draft: { ...current.draft, ...patch }, error: null, notice: null }));
	const setConnections = (connections: ConnectionSettings) => setState((current) => ({ ...current, connections }));
	const save = async (command: MemorySettingsCommand, applied: (settings: MemorySettings) => void) => {
		setState((current) => ({ ...current, pending: true, error: null, notice: null }));
		const result = await saveMemorySettings(command);
		if (result.outcome === "applied") applied(result.settings);
		else if (result.outcome === "conflict") setState((current) => ({ ...current, settings: result.currentSettings, pending: false, notice: "Memory Settings changed elsewhere. Review the current values before saving again." }));
		else setState((current) => ({ ...current, pending: false, error: result.reason }));
		return result.outcome === "applied";
	};
	const { settings, draft, connections } = state;
	const dirty = settings !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(settings));
	const submit = async () => settings !== null && draft !== null && save({ expectedRevision: settings.revision, enabled: settings.enabled, ...draft }, (saved) => applyLoaded(saved, connections));
	useSaveGuard({ dirty, saving: state.pending, save: submit, discard: () => setState((current) => current.settings === null ? current : ({ ...current, draft: draftOf(current.settings), error: null, notice: null })) });
	if (state.loading) return <div className="panel-body settings-panel-body"><section aria-busy="true"><h3>Conversation Memory</h3><p role="status">Loading Memory Settings…</p></section></div>;
	if (settings === null || draft === null) return <div className="panel-body settings-panel-body"><section><h3>Conversation Memory</h3><div className="settings-feedback-error" role="alert"><p>{state.error}</p><Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>Try again</Button></div></section></div>;
	const toggle = (enabled: boolean) => save({ ...draftOf(settings), expectedRevision: settings.revision, enabled }, (saved) => setState((current) => ({ ...current, settings: saved, pending: false })));
	const profileOf = (id: number | null) => connections?.profiles.find((profile) => profile.id === id);
	const extractionProfile = profileOf(draft.extractionProfileId);
	const embeddingProfile = profileOf(draft.embeddingProfileId);
	const missingProfile = [settings.extractionProfileId, settings.embeddingProfileId].some((id) => id !== null && profileOf(id) === undefined);
	return (
		<><div className="panel-body settings-panel-body">
			<section aria-labelledby="memory-settings-title">
				<div className="flex items-center justify-between gap-3">
					<h3 id="memory-settings-title">Conversation Memory</h3>
					<Switch checked={settings.enabled} disabled={state.pending} aria-label={settings.enabled ? "Turn off Memory" : "Turn on Memory"} onCheckedChange={(enabled) => void toggle(enabled)} />
				</div>
				{!settings.enabled && <p className="settings-feedback" role="status">Memory is off. No Memories are recalled into prompts and no new Memories are extracted.</p>}
				<p>Extraction runs separately from writing generations.</p>
				{missingProfile && <p className="settings-feedback-error" role="alert">A saved Memory connection no longer exists. Choose an available model.</p>}
				{(!extractionProfile?.credentialConfigured || draft.extractionModel.length === 0) && <p className="settings-feedback" role="status">Memory extraction is not ready. Choose an extraction model whose connection has an API key, and configure the Typesafe credential in Connections.</p>}
				{(embeddingProfile === undefined || draft.embeddingModel.length === 0) && <p className="settings-feedback" role="status">Memory recall is not ready. Choose an embedding model so saved Memories can be recalled.</p>}
				<div className="grid grid-cols-1 gap-4">
					<Field label="Extraction model" helper="A chat model that reads each Message and proposes Memories.">
						<ProfileModelPicker settings={connections} onSettingsChange={setConnections} accepts={isChatProfile} selected={{ connectionProfileId: draft.extractionProfileId, modelId: draft.extractionModel }} onSelect={(profile, modelId) => update({ extractionProfileId: profile.id, extractionModel: modelId })} emptyLabel="Add a chat connection in Connections to choose a model.">
							<ChoiceTrigger label="Extraction model" profile={extractionProfile} profileId={draft.extractionProfileId} modelId={draft.extractionModel} />
						</ProfileModelPicker>
					</Field>
					<Field label="Embedding model" helper="Shortlists saved Memories for recall. Changing it rebuilds Memory indexes.">
						<ProfileModelPicker settings={connections} onSettingsChange={setConnections} accepts={isEmbeddingsProfile} selected={{ connectionProfileId: draft.embeddingProfileId, modelId: draft.embeddingModel }} onSelect={(profile, modelId) => update({ embeddingProfileId: profile.id, embeddingModel: modelId })} emptyLabel="Add an Embeddings connection in Connections to choose a model.">
							<ChoiceTrigger label="Embedding model" profile={embeddingProfile} profileId={draft.embeddingProfileId} modelId={draft.embeddingModel} />
						</ProfileModelPicker>
					</Field>
				</div>
				<NumberGroup title="Extraction budget" description="Estimated tokens for each extraction request.">
					<NumberRow id="memory-context-limit" label="Context limit" min={1} step={1} value={draft.contextLimit} onChange={(contextLimit) => update({ contextLimit })} />
					<NumberRow id="memory-output-reserve" label="Output reserve" min={1} step={1} value={draft.outputReserve} onChange={(outputReserve) => update({ outputReserve })} />
					<NumberRow id="memory-safety-allowance" label="Safety allowance" min={0} step={1} value={draft.safetyAllowance} onChange={(safetyAllowance) => update({ safetyAllowance })} />
				</NumberGroup>
				<NumberGroup title="Jev thresholds" description="Keep a Memory when Jev is at least this confident it is useful; recall it when Jev scores it at least this relevant.">
					<NumberRow id="memory-usefulness-gate" label="Usefulness (0–1)" min={0} max={1} step={0.05} value={draft.usefulnessConfidenceGate} onChange={(usefulnessConfidenceGate) => update({ usefulnessConfidenceGate })} />
					<NumberRow id="memory-relevance-minimum" label="Relevance (0–3)" min={0} max={3} step={0.25} value={draft.recallRelevanceMinimum} onChange={(recallRelevanceMinimum) => update({ recallRelevanceMinimum })} />
				</NumberGroup>
				{state.notice && <p className="settings-feedback" role="status">{state.notice}</p>}
			</section>
		</div><SaveFooter dirty={dirty} saving={state.pending} error={state.error} onSave={() => void submit()} /></>
	);
}

function ChoiceTrigger({ label, profile, profileId, modelId, ...props }: { label: string; profile: ConnectionProfile | undefined; profileId: number | null; modelId: string }) {
	const text = profile !== undefined ? <>{profile.displayName} · <span className="font-mono text-[0.78rem]">{modelId}</span></> : profileId !== null ? "Unavailable connection" : "Choose a model";
	return (
		<button type="button" aria-label={`${label}: ${profile ? `${profile.displayName} / ${modelId}` : "Choose a model"}`} className="field-input flex min-w-0 items-center justify-between gap-2 text-left" {...props}>
			<span className={profile ? "min-w-0 truncate" : "text-muted-foreground"}>{text}</span>
			<ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
		</button>
	);
}

function NumberGroup({ title, description, children }: { title: string; description: string; children: ReactNode }) {
	return (
		<div className="mt-6 grid gap-2">
			<h4 className="m-0 text-[0.8rem] font-semibold">{title}</h4>
			<p className="-mt-1 mb-1 text-xs leading-normal text-muted-foreground">{description}</p>
			{children}
		</div>
	);
}

function NumberRow({ id, label, value, onChange, ...limits }: { id: string; label: string; value: number; min: number; max?: number; step: number; onChange: (value: number) => void }) {
	return (
		<div className="flex items-center justify-between gap-3">
			<label htmlFor={id} className="whitespace-nowrap text-[13px] font-medium text-muted-foreground">{label}</label>
			<span className="w-20"><input id={id} className="field-input text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" type="number" {...limits} value={value} onChange={(event) => onChange(Number(event.target.value))} /></span>
		</div>
	);
}
