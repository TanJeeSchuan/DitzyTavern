import { ChevronLeft } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ProfileModelPicker } from "../ProfileModelPicker";
import { loadConnectionSettings, type ConnectionSettings } from "../connection-settings";
import { Slider } from "@/components/ui/slider";
import { loadSemanticTriggerSettings, saveSemanticTriggerSettings, type SemanticTriggerSettings, type SemanticTriggerSettingsResult } from "../semantic-trigger-settings";
import type { SemanticTriggerSettingsCommand } from "../../shared/contract/semantic-trigger-settings";
import { useAsyncEffect } from "../lib/use-async";
import { SaveFooter } from "../SaveFooter";
import { useSaveGuard, useSaveNavigation } from "../SaveGuard";


type Draft = Omit<SemanticTriggerSettings, "revision">;
type State = { settings: SemanticTriggerSettings | null; draft: Draft | null; loading: boolean; pending: boolean; error: string | null };

const CONFLICT_ERROR = "These settings changed elsewhere. Review your draft before saving again.";
const draftOf = ({ revision: _revision, ...draft }: SemanticTriggerSettings): Draft => draft;

export type SemanticTriggerSettingsController = ReturnType<typeof useSemanticTriggerSettings>;

export function useSemanticTriggerSettings() {
	const [state, setState] = useState<State>({ settings: null, draft: null, loading: true, pending: false, error: null });
	const loaded = (settings: SemanticTriggerSettings): State => ({ settings, draft: draftOf(settings), loading: false, pending: false, error: null });

	const load = useCallback((isCancelled: () => boolean = () => false) => loadSemanticTriggerSettings()
		.then((settings) => { if (!isCancelled()) setState(loaded(settings)); })
		.catch(() => { if (!isCancelled()) setState((current) => ({ ...current, loading: false, error: "Semantic Trigger Settings could not be loaded." })); }), []);
	useAsyncEffect((isCancelled) => { void load(isCancelled); }, [load]);

	const settle = (result: SemanticTriggerSettingsResult, keepDraft: (draft: Draft | null) => boolean) => {
		if (result.outcome === "applied") setState((current) => ({ ...loaded(result.settings), draft: keepDraft(current.draft) ? current.draft : draftOf(result.settings) }));
		else if (result.outcome === "conflict") setState((current) => ({ ...current, settings: result.currentSettings, pending: false, error: CONFLICT_ERROR }));
		else setState((current) => ({ ...current, pending: false, error: result.reason }));
		return result.outcome === "applied";
	};

	const { settings, draft } = state;
	const dirty = settings !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(settings));

	const save = async () => {
		if (settings === null || draft === null) return false;
		setState((current) => ({ ...current, pending: true, error: null }));
		const fields = draft;
		const command: SemanticTriggerSettingsCommand = { type: "apply", expectedRevision: settings.revision, ...fields };
		return settle(await saveSemanticTriggerSettings(command), (current) => current !== draft);
	};

	return {
		...state,
		dirty,
		reload: () => { setState((current) => ({ ...current, loading: true, error: null })); void load(); },
		update: (patch: Partial<Draft>) => setState((current) => current.draft === null ? current : { ...current, draft: { ...current.draft, ...patch }, error: null }),
		discard: () => setState((current) => current.settings === null ? current : { ...current, draft: draftOf(current.settings), error: null }),
		save,
	};
}

export function SemanticTriggerSettingsEditor({ semanticTriggers, onBack }: { semanticTriggers: SemanticTriggerSettingsController; onBack: () => void }) {
	const navigate = useSaveNavigation();
	const [connections, setConnections] = useState<ConnectionSettings | null>(null);
	useAsyncEffect(() => { void loadConnectionSettings().then(setConnections); }, []);
	useSaveGuard({ dirty: semanticTriggers.dirty, saving: semanticTriggers.pending, save: semanticTriggers.save, discard: semanticTriggers.discard });
	const { settings, draft } = semanticTriggers;
	return (
		<>
			<div className="panel-body settings-panel-body">
				<Button type="button" size="sm" variant="ghost" className="-ml-2 mb-3 text-muted-foreground" onClick={() => navigate(onBack)}><ChevronLeft aria-hidden="true" /> Connections</Button>
				<section aria-labelledby="semantic-trigger-settings-title">
					<h3 id="semantic-trigger-settings-title" className="text-base! font-semibold">Semantic Triggers</h3>
					<p>Choose a Decision Model to match Lore Entries by their Semantic Triggers. Clear the selection for keyword-only matching.</p>
					{settings === null || draft === null ? (
						<div className="grid justify-items-start gap-2">
							<p className="text-xs text-destructive" role="alert">{semanticTriggers.error ?? "Semantic Trigger Settings could not be loaded."}</p>
							<Button type="button" size="sm" variant="outline" onClick={semanticTriggers.reload}>Try again</Button>
						</div>
					) : (
						<div className="grid gap-4">
                            <Field label="Decision Model" helper="System One connections only. Memory has its own selection.">
                                <ProfileModelPicker settings={connections} onSettingsChange={setConnections} decisions selected={{ connectionProfileId: draft.decisionProfileId, modelId: draft.decisionModel }} onSelect={(profile, decisionModel) => semanticTriggers.update({ decisionProfileId: profile.id, decisionModel })} emptyLabel="Add a System One connection in Connections." label="Semantic Trigger Decision Model" />
                                {draft.decisionProfileId !== null && <Button type="button" size="sm" variant="ghost" onClick={() => semanticTriggers.update({ decisionProfileId: null, decisionModel: "" })}>Clear selection</Button>}
                            </Field>
                            <Field htmlFor="semantic-state-limit" label="State token limit" helper="Long scenes are split so the model reads the whole Lore Scan Window.">
                                <input id="semantic-state-limit" className="field-input" type="number" min={1} step={1} value={draft.decisionStateTokenLimit} onChange={event => semanticTriggers.update({ decisionStateTokenLimit: Number(event.target.value) })} />
                            </Field>
							<div className="grid gap-1.5">
								<div className="flex items-center justify-between gap-3">
									<label htmlFor="semanticTriggers-threshold" className="text-[13px] font-medium text-muted-foreground">Trigger threshold</label>
									<span className="text-[13px] tabular-nums">{draft.triggerThreshold.toFixed(2)}</span>
								</div>
								<Slider id="semanticTriggers-threshold" className="py-1.5 [&_[data-slot=slider-track]]:bg-foreground/15" min={0} max={1} step={0.05} disabled={draft.decisionProfileId === null} value={[draft.triggerThreshold]} onValueChange={([triggerThreshold]) => { if (triggerThreshold !== undefined) semanticTriggers.update({ triggerThreshold }); }} aria-label="Trigger threshold" />
								<small className="text-xs text-muted-foreground">The Decision Model's probability that a trigger's situation happens in the scene. Starts at 0.50.</small>
							</div>
						</div>
					)}
				</section>
			</div>
			<SaveFooter dirty={semanticTriggers.dirty} saving={semanticTriggers.pending} error={semanticTriggers.error} onSave={() => void semanticTriggers.save()} />
		</>
	);
}

