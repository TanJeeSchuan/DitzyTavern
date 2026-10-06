import { CircleHelp } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { loadConnectionSettings, type ConnectionSettings } from "../connection-settings";
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
	const submit = async () => settings !== null && draft !== null && save({ expectedRevision: settings.revision, enabled: settings.enabled, ...draft }, (saved) => setState((current) => ({ ...current, settings: saved, draft: current.draft === draft ? draftOf(saved) : current.draft, pending: false, error: null, notice: null })));
	useSaveGuard({ dirty, saving: state.pending, save: submit, discard: () => setState((current) => current.settings === null ? current : ({ ...current, draft: draftOf(current.settings), error: null, notice: null })) });
	if (state.loading) return <div className="panel-body settings-panel-body"><section aria-busy="true"><h3>Conversation Memory</h3><p role="status">Loading Memory Settings…</p></section></div>;
	if (settings === null || draft === null) return <div className="panel-body settings-panel-body"><section><h3>Conversation Memory</h3><div className="settings-feedback-error" role="alert"><p>{state.error}</p><Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>Try again</Button></div></section></div>;
	const toggle = (enabled: boolean) => save({ ...draftOf(settings), expectedRevision: settings.revision, enabled }, (saved) => setState((current) => ({ ...current, settings: saved, pending: false })));
	const profileOf = (id: number | null) => connections?.profiles.find((profile) => profile.id === id);
	const extractionProfile = profileOf(draft.extractionProfileId);
	const embeddingProfile = profileOf(draft.embeddingProfileId);
	const missingProfile = [settings.extractionProfileId, settings.embeddingProfileId, settings.decisionProfileId].some((id) => id !== null && profileOf(id) === undefined);
	return (
		<><div className="panel-body settings-panel-body">
			<section aria-labelledby="memory-settings-title">
				<div className="flex items-center justify-between gap-3">
					<h3 id="memory-settings-title">Conversation Memory</h3>
					<Switch checked={settings.enabled} disabled={state.pending} aria-label={settings.enabled ? "Turn off Memory" : "Turn on Memory"} onCheckedChange={(enabled) => void toggle(enabled)} />
				</div>
				{!settings.enabled && <p className="settings-feedback" role="status">Memory is off. No Memories are recalled into prompts and no new Memories are extracted.</p>}
				<p>Extraction runs separately from writing generations.</p>
				{draft.decisionProfileId === null && <p className="settings-feedback" role="status">Choose a Decision Model to enable Memory judgment and recall.</p>}
				{missingProfile && <p className="settings-feedback-error" role="alert">A saved Memory connection no longer exists. Choose an available model.</p>}
				{(!extractionProfile?.credentialConfigured || draft.extractionModel.length === 0) && <p className="settings-feedback" role="status">Memory extraction is not ready. Choose an extraction model whose connection has an API key, and choose a Decision Model below.</p>}
				{(embeddingProfile === undefined || draft.embeddingModel.length === 0) && <p className="settings-feedback" role="status">Memory recall is not ready. Choose an embedding model so saved Memories can be recalled.</p>}
				<div className="grid grid-cols-1 gap-4">
					<Field label="Extraction model" helper="A chat model that reads each Message and proposes Memories.">
						<ProfileModelPicker settings={connections} onSettingsChange={setConnections} selected={{ connectionProfileId: draft.extractionProfileId, modelId: draft.extractionModel }} onSelect={(profile, modelId) => update({ extractionProfileId: profile.id, extractionModel: modelId })} emptyLabel="Add a chat connection in Connections to choose a model." label="Extraction model" />
					</Field>
					<Field label="Decision Model" helper="Judges proposed Memories and scores saved Memories during recall. System One connections only.">
						<ProfileModelPicker settings={connections} onSettingsChange={setConnections} decisions selected={{ connectionProfileId: draft.decisionProfileId, modelId: draft.decisionModel }} onSelect={(profile, decisionModel) => update({ decisionProfileId: profile.id, decisionModel })} emptyLabel="Add a System One connection in Connections." label="Memory Decision Model" />
						{draft.decisionProfileId !== null && <Button type="button" size="sm" variant="ghost" onClick={() => update({ decisionProfileId: null, decisionModel: "" })}>Clear selection</Button>}
					</Field>
					<Field label="Embedding model" helper="Shortlists saved Memories for recall. Changing it rebuilds Memory indexes.">
						<ProfileModelPicker settings={connections} onSettingsChange={setConnections} embeddings selected={{ connectionProfileId: draft.embeddingProfileId, modelId: draft.embeddingModel }} onSelect={(profile, modelId) => update({ embeddingProfileId: profile.id, embeddingModel: modelId })} emptyLabel="Add an Embeddings connection in Connections to choose a model." label="Embedding model" />
					</Field>
				</div>
				<NumberGroup title={<>Extraction budget <Popover>
					<PopoverTrigger asChild><Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label="How Decision Models handle Memory"><CircleHelp className="size-3.5" aria-hidden="true" /></Button></PopoverTrigger>
					<PopoverContent align="start" aria-label="How Decision Models handle Memory" className="text-xs leading-relaxed">
						<p>Your extraction model proposes Memories using this token budget.</p>
						<p>The Decision Model then checks whether the source supports each claim, whether it is attributed to the right person, and whether it will matter beyond the current scene. Only claims that pass these checks and the retain probability minimum are kept.</p>
						<p>During recall, the Decision Model scores saved Memories for relevance to the current scene. Choose its System One connection and model here.</p>
					</PopoverContent>
				</Popover></>} description="Estimated tokens for each extraction request.">
					<NumberRow id="memory-context-limit" label="Context limit" min={1} step={1} value={draft.contextLimit} onChange={(contextLimit) => update({ contextLimit })} />
					<NumberRow id="memory-output-reserve" label="Output reserve" min={1} step={1} value={draft.outputReserve} onChange={(outputReserve) => update({ outputReserve })} />
					<NumberRow id="memory-safety-allowance" label="Safety allowance" min={0} step={1} value={draft.safetyAllowance} onChange={(safetyAllowance) => update({ safetyAllowance })} />
				</NumberGroup>
				<NumberGroup title="Decision Model state" description="Maximum state sent for judgment and recall. Oversized extraction sources fail visibly.">
					<NumberRow id="memory-decision-state-limit" label="State token limit" min={1} step={1} value={draft.decisionStateTokenLimit} onChange={(decisionStateTokenLimit) => update({ decisionStateTokenLimit })} />
				</NumberGroup>
				<NumberGroup title="Decision thresholds" description="Retain probability controls admission. Relevance score controls recall.">
					<NumberRow id="memory-retain-probability-minimum" label="Retain probability minimum (0–1)" min={0} max={1} step={0.05} value={draft.retainProbabilityMinimum} onChange={(retainProbabilityMinimum) => update({ retainProbabilityMinimum })} />
					<NumberRow id="memory-relevance-minimum" label="Relevance (0–3)" min={0} max={3} step={0.25} value={draft.recallRelevanceMinimum} onChange={(recallRelevanceMinimum) => update({ recallRelevanceMinimum })} />
				</NumberGroup>
				{state.notice && <p className="settings-feedback" role="status">{state.notice}</p>}
			</section>
		</div><SaveFooter dirty={dirty} saving={state.pending} error={state.error} onSave={() => void submit()} /></>
	);
}

function NumberGroup({ title, description, children }: { title: ReactNode; description: string; children: ReactNode }) {
	return (
		<div className="mt-6 grid gap-2">
			<h4 className="m-0 flex items-center gap-1 text-[0.8rem] font-semibold">{title}</h4>
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
