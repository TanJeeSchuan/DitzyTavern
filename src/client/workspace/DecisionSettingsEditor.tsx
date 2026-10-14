import { ChevronLeft } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { DecisionModelPicker } from "../DecisionModelPicker";
import { useConnectionSettingsQuery } from "../connection-settings-query";
import { useAsyncEffect } from "../lib/use-async";
import type { RequestOutcome } from "../lib/request-outcome";
import { SaveFooter } from "../SaveFooter";
import { useSaveGuard, useNavigationRequest } from "../SaveGuard";
import { NumberGroup, NumberRow } from "./NumberControls";
import { MIN_DECISION_STATE_TOKEN_LIMIT, type DecisionSelection } from "../../shared/contract/decision-model";

type Settings = DecisionSelection & { revision: number };
type SaveOutcome<S> = RequestOutcome<{ settings: S }, { outcome: "conflict"; currentSettings: S } | { outcome: "invalid"; reason: string } | { outcome: "not-found" }>;
type State<S> = { settings: S | null; draft: Omit<S, "revision"> | null; loading: boolean; pending: boolean; error: string | null };

const CONFLICT_ERROR = "These settings changed elsewhere. Review your draft before saving again.";
const draftOf = <S extends Settings>({ revision: _revision, ...draft }: S): Omit<S, "revision"> => draft;

/** @approved The draft and commands a revisioned Decision Model settings editor reads and writes. */
export type SettingsDraft<S extends Settings> = State<S> & {
	dirty: boolean;
	reload: () => void;
	update: (patch: Partial<DecisionSelection> | Partial<Omit<S, "revision">>) => void;
	discard: () => void;
	save: () => Promise<boolean>;
};

export function useSettingsDraft<S extends Settings>(
	name: string,
	load: () => Promise<S>,
	apply: (command: Omit<S, "revision"> & { type: "apply"; expectedRevision: number }) => Promise<SaveOutcome<S>>,
): SettingsDraft<S> {
	const [state, setState] = useState<State<S>>({ settings: null, draft: null, loading: true, pending: false, error: null });
	const loaded = (settings: S): State<S> => ({ settings, draft: draftOf(settings), loading: false, pending: false, error: null });

	const reload = useCallback((isCancelled: () => boolean = () => false) => load()
		.then((settings) => { if (!isCancelled()) setState(loaded(settings)); })
		.catch(() => { if (!isCancelled()) setState((current) => ({ ...current, loading: false, error: `${name} could not be loaded.` })); }), [load, name]);
	useAsyncEffect((isCancelled) => { void reload(isCancelled); }, [reload]);

	const { settings, draft } = state;
	const dirty = settings !== null && draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(settings));

	const save = async () => {
		if (settings === null || draft === null) return false;
		setState((current) => ({ ...current, pending: true, error: null }));
		const result = await apply({ ...draft, type: "apply", expectedRevision: settings.revision });
		if (result.outcome === "available") setState((current) => ({ ...loaded(result.value.settings), draft: current.draft !== draft ? current.draft : draftOf(result.value.settings) }));
		else if (result.outcome === "conflict") setState((current) => ({ ...current, settings: result.currentSettings, pending: false, error: CONFLICT_ERROR }));
		else setState((current) => ({ ...current, pending: false, error: result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : `${name} could not be saved.` }));
		return result.outcome === "available";
	};

	return {
		...state,
		dirty,
		reload: () => { setState((current) => ({ ...current, loading: true, error: null })); void reload(); },
		// @approved
		// SAFETY: S extends DecisionSelection, so a patch of S's own fields keeps the draft's shape.
		update: (patch) => setState((current) => current.draft === null ? current : { ...current, draft: { ...current.draft, ...patch } as Omit<S, "revision">, error: null }),
		discard: () => setState((current) => current.settings === null ? current : { ...current, draft: draftOf(current.settings), error: null }),
		save,
	};
}

export function DecisionSettingsEditor<S extends Settings>({ editor, id, title, description, pickerLabel, pickerHelper, stateDescription, onBack, children }: {
	editor: SettingsDraft<S>;
	id: string;
	title: string;
	description: string;
	pickerLabel: string;
	pickerHelper: string;
	stateDescription: string;
	onBack: () => void;
	children?: (draft: Omit<S, "revision">) => ReactNode;
}) {
	const navigate = useNavigationRequest();
	const connections = useConnectionSettingsQuery({ refreshOnOpen: true });
	useSaveGuard({ dirty: editor.dirty, saving: editor.pending, save: editor.save, discard: editor.discard });
	const { settings, draft } = editor;
	return (
		<>
			<div className="panel-body settings-panel-body">
				<Button type="button" size="sm" variant="ghost" className="-ml-2 mb-3 text-muted-foreground" onClick={() => navigate(onBack)}><ChevronLeft aria-hidden="true" /> Connections</Button>
				<section aria-labelledby={`${id}-title`}>
					<h3 id={`${id}-title`} className="text-base! font-semibold">{title}</h3>
					<p>{description}</p>
					{settings === null || draft === null ? (
						<div className="grid justify-items-start gap-2">
							<p className="text-xs text-destructive" role="alert">{editor.error ?? `${title} settings could not be loaded.`}</p>
							<Button type="button" size="sm" variant="outline" onClick={editor.reload}>Try again</Button>
						</div>
					) : (
						<div className="grid gap-4">
							{connections.isError ? <div className="grid justify-items-start gap-2">
								<p className="text-xs text-destructive" role="alert">Connection Settings could not be loaded.</p>
								<Button type="button" size="sm" variant="outline" onClick={() => void connections.refetch()}>Try again</Button>
							</div> : <Field label="Decision Model" helper={pickerHelper}>
								<DecisionModelPicker selection={draft} onChange={editor.update} label={pickerLabel} />
							</Field>}
							<NumberGroup title="Decision Model state" description={stateDescription}>
								<NumberRow
									id={`${id}-state-limit`}
									label="State token limit"
									min={MIN_DECISION_STATE_TOKEN_LIMIT}
									step={1}
									value={draft.decisionStateTokenLimit}
									onChange={(decisionStateTokenLimit) => editor.update({ decisionStateTokenLimit })}
								/>
							</NumberGroup>
							{children?.(draft)}
						</div>
					)}
				</section>
			</div>
			<SaveFooter dirty={editor.dirty} saving={editor.pending} error={editor.error} onSave={() => void editor.save()} />
		</>
	);
}
