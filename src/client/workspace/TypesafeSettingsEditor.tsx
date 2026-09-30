import { ChevronLeft } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Slider } from "@/components/ui/slider";
import { loadTypesafeSettings, saveTypesafeSettings, type TypesafeSettings, type TypesafeSettingsResult } from "../typesafe-settings";
import type { TypesafeSettingsCommand } from "../../shared/contract/typesafe";
import { useAsyncEffect } from "../lib/use-async";
import { SaveFooter } from "../SaveFooter";
import { useSaveGuard, useSaveNavigation } from "../SaveGuard";
import { CredentialField } from "./connection-settings/CredentialField";

type Draft = Pick<TypesafeSettings, "jevModel" | "loreTriggerMode" | "loreTriggerThreshold"> & { credential: string };
type State = { settings: TypesafeSettings | null; draft: Draft | null; loading: boolean; pending: boolean; error: string | null };

const CONFLICT_ERROR = "These settings changed elsewhere. Review your draft before saving again.";
const draftOf = (settings: TypesafeSettings): Draft => ({ jevModel: settings.jevModel, loreTriggerMode: settings.loreTriggerMode, loreTriggerThreshold: settings.loreTriggerThreshold, credential: "" });

export type TypesafeSettingsController = ReturnType<typeof useTypesafeSettings>;

export function useTypesafeSettings() {
	const [state, setState] = useState<State>({ settings: null, draft: null, loading: true, pending: false, error: null });
	const loaded = (settings: TypesafeSettings): State => ({ settings, draft: draftOf(settings), loading: false, pending: false, error: null });

	const load = useCallback((isCancelled: () => boolean = () => false) => loadTypesafeSettings()
		.then((settings) => { if (!isCancelled()) setState(loaded(settings)); })
		.catch(() => { if (!isCancelled()) setState((current) => ({ ...current, loading: false, error: "Typesafe Settings could not be loaded." })); }), []);
	useAsyncEffect((isCancelled) => { void load(isCancelled); }, [load]);

	const settle = (result: TypesafeSettingsResult, keepDraft: (draft: Draft | null) => boolean) => {
		if (result.outcome === "applied") setState((current) => ({ ...loaded(result.settings), draft: keepDraft(current.draft) ? current.draft : draftOf(result.settings) }));
		else if (result.outcome === "conflict") setState((current) => ({ ...current, settings: result.currentSettings, pending: false, error: CONFLICT_ERROR }));
		else setState((current) => ({ ...current, pending: false, error: result.reason }));
		return result.outcome === "applied";
	};

	const { settings, draft } = state;
	const dirty = settings !== null && draft !== null && (draft.jevModel !== settings.jevModel || draft.loreTriggerMode !== settings.loreTriggerMode || draft.loreTriggerThreshold !== settings.loreTriggerThreshold || draft.credential.length > 0);

	const save = async () => {
		if (settings === null || draft === null) return false;
		setState((current) => ({ ...current, pending: true, error: null }));
		const { credential, ...fields } = draft;
		const command: TypesafeSettingsCommand = { type: "apply", expectedRevision: settings.revision, ...fields };
		if (credential.length > 0) command.credential = credential;
		return settle(await saveTypesafeSettings(command), (current) => current !== draft);
	};

	const removeCredential = async () => {
		if (settings === null) return;
		setState((current) => ({ ...current, pending: true, error: null }));
		settle(await saveTypesafeSettings({ type: "apply", expectedRevision: settings.revision, jevModel: settings.jevModel, loreTriggerMode: settings.loreTriggerMode, loreTriggerThreshold: settings.loreTriggerThreshold, credential: "" }), () => true);
	};

	return {
		...state,
		dirty,
		reload: () => { setState((current) => ({ ...current, loading: true, error: null })); void load(); },
		update: (patch: Partial<Draft>) => setState((current) => current.draft === null ? current : { ...current, draft: { ...current.draft, ...patch }, error: null }),
		discard: () => setState((current) => current.settings === null ? current : { ...current, draft: draftOf(current.settings), error: null }),
		save,
		removeCredential,
	};
}

export function TypesafeSettingsEditor({ typesafe, onBack }: { typesafe: TypesafeSettingsController; onBack: () => void }) {
	const navigate = useSaveNavigation();
	useSaveGuard({ dirty: typesafe.dirty, saving: typesafe.pending, save: typesafe.save, discard: typesafe.discard });
	const { settings, draft } = typesafe;
	return (
		<>
			<div className="panel-body settings-panel-body">
				<Button type="button" size="sm" variant="ghost" className="-ml-2 mb-3 text-muted-foreground" onClick={() => navigate(onBack)}><ChevronLeft aria-hidden="true" /> Connections</Button>
				<section aria-labelledby="typesafe-settings-title">
					<h3 id="typesafe-settings-title" className="text-base! font-semibold">Typesafe Jev</h3>
					<p>Jev judges Memory candidates and recall, and matches Lore Entries by their Semantic Triggers.</p>
					{settings === null || draft === null ? (
						<div className="grid justify-items-start gap-2">
							<p className="text-xs text-destructive" role="alert">{typesafe.error ?? "Typesafe Settings could not be loaded."}</p>
							<Button type="button" size="sm" variant="outline" onClick={typesafe.reload}>Try again</Button>
						</div>
					) : (
						<div className="grid gap-4">
							<CredentialField
								id="typesafe-credential"
								label="API key"
								value={draft.credential}
								onChange={(credential) => typesafe.update({ credential })}
								configured={settings.credentialConfigured}
								pending={typesafe.pending}
								onRemove={() => void typesafe.removeCredential()}
								placeholder="Required for Memory and Semantic Triggers"
							/>
							<Field htmlFor="typesafe-model" label="Jev model">
								<input id="typesafe-model" className="field-input font-mono text-[0.78rem]!" value={draft.jevModel} onChange={(event) => typesafe.update({ jevModel: event.target.value })} autoComplete="off" />
							</Field>
							<div className="grid gap-1.5">
								<span className="text-[13px] font-medium text-muted-foreground">Lore Semantic Triggers</span>
								<SegmentedControl value={draft.loreTriggerMode} onValueChange={(loreTriggerMode) => typesafe.update({ loreTriggerMode })} label="Lore Semantic Triggers" options={[{ value: "jev", label: "Matched by Jev" }, { value: "off", label: "Off" }]} />
								<small className="text-xs text-muted-foreground">Off matches Lore Entries by Keywords only.</small>
							</div>
							<div className="grid gap-1.5">
								<div className="flex items-center justify-between gap-3">
									<label htmlFor="typesafe-threshold" className="text-[13px] font-medium text-muted-foreground">Trigger threshold</label>
									<span className="text-[13px] tabular-nums">{draft.loreTriggerThreshold.toFixed(2)}</span>
								</div>
								<Slider id="typesafe-threshold" className="py-1.5 [&_[data-slot=slider-track]]:bg-foreground/15" min={0} max={1} step={0.05} disabled={draft.loreTriggerMode === "off"} value={[draft.loreTriggerThreshold]} onValueChange={([loreTriggerThreshold]) => { if (loreTriggerThreshold !== undefined) typesafe.update({ loreTriggerThreshold }); }} aria-label="Trigger threshold" />
								<small className="text-xs text-muted-foreground">Jev's probability that a trigger's situation happens in the scene. Starts at 0.50.</small>
							</div>
						</div>
					)}
				</section>
			</div>
			<SaveFooter dirty={typesafe.dirty} saving={typesafe.pending} error={typesafe.error} onSave={() => void typesafe.save()} />
		</>
	);
}
