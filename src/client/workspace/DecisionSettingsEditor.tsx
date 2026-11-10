import { ChevronLeft } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { DecisionModelPicker } from "../DecisionModelPicker";
import { useConnectionSettingsQuery } from "../connection-settings-query";
import { useAsyncEffect } from "../lib/use-async";
import { useRevisionedDraft } from "../lib/revisioned-draft";
import { ConflictBanner } from "../ConflictBanner";
import type { RequestOutcome } from "../lib/request-outcome";
import { SaveFooter } from "../SaveFooter";
import { useSaveGuard, useNavigationRequest } from "../SaveGuard";
import { NumberGroup, NumberRow } from "./NumberControls";
import { MIN_DECISION_STATE_TOKEN_LIMIT, type DecisionSelection } from "../../shared/contract/decision-model";

type Revisioned = { revision: number };
type Settings = DecisionSelection & Revisioned;
type SaveOutcome<S> = RequestOutcome<{ settings: S }, { outcome: "conflict"; currentSettings: S } | { outcome: "invalid"; reason: string } | { outcome: "not-found" }>;
type Read<S> = { settings: S | null; loading: boolean; error: string | null };

const CONFLICT_ERROR = "These settings changed elsewhere. Review your draft before saving again.";
const draftOf = <S extends Revisioned>({ revision: _revision, ...draft }: S): Omit<S, "revision"> => draft;
const revisioned = <S extends Revisioned>(settings: S) => ({ value: draftOf(settings), revision: settings.revision });
const same = <T,>(left: T, right: T) => JSON.stringify(left) === JSON.stringify(right);

/** @approved The draft and commands a revisioned model settings editor reads and writes. */
export type SettingsDraft<S extends Revisioned> = Read<S> & {
	draft: Omit<S, "revision"> | null;
	pending: boolean;
	dirty: boolean;
	conflict: boolean;
	reload: () => void;
	update: (patch: Partial<Omit<S, "revision">>) => void;
	discard: () => void;
	keepMine: () => void;
	save: () => Promise<boolean>;
};

export function useSettingsDraft<S extends Revisioned>(
	name: string,
	load: () => Promise<S>,
	apply: (command: Omit<S, "revision"> & { type: "apply"; expectedRevision: number }) => Promise<SaveOutcome<S>>,
): SettingsDraft<S> {
	const [read, setRead] = useState<Read<S>>({ settings: null, loading: true, error: null });
	const reload = useCallback((isCancelled: () => boolean = () => false) => load()
		.then((settings) => { if (!isCancelled()) setRead({ settings, loading: false, error: null }); })
		.catch(() => { if (!isCancelled()) setRead((current) => ({ ...current, loading: false, error: `${name} could not be loaded.` })); }), [load, name]);
	useAsyncEffect((isCancelled) => { void reload(isCancelled); }, [reload]);

	const editor = useRevisionedDraft(read.settings === null ? null : revisioned(read.settings), {
		equals: same,
		save: async (submitted, expectedRevision) => {
			setRead((current) => ({ ...current, error: null }));
			const result = await apply({ ...submitted, type: "apply", expectedRevision });
			if (result.outcome === "available") return { outcome: "saved", saved: revisioned(result.value.settings) };
			if (result.outcome === "conflict") return { outcome: "conflict", theirs: revisioned(result.currentSettings) };
			setRead((current) => ({ ...current, error: result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : `${name} could not be saved.` }));
			return { outcome: "failed" };
		},
	});

	return {
		...read,
		// @approved
		// SAFETY: the session's authoritative copy is draftOf(S) at its revision, so restoring the revision restores S.
		settings: editor.saved === null ? read.settings : { ...editor.saved.value, revision: editor.saved.revision } as S,
		draft: editor.value,
		pending: editor.saving,
		dirty: editor.dirty,
		conflict: editor.conflict,
		reload: () => { setRead((current) => ({ ...current, loading: true, error: null })); void reload(); },
		update: (patch) => {
			// @approved
			// SAFETY: a patch of S's own fields keeps the draft's shape.
			editor.update((current) => ({ ...current, ...patch }) as Omit<S, "revision">);
			setRead((current) => ({ ...current, error: null }));
		},
		discard: () => { editor.discard(); setRead((current) => ({ ...current, error: null })); },
		keepMine: editor.keepMine,
		save: editor.save,
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
	// @approved
	// SAFETY: S extends DecisionSelection, so a patch of its fields is a patch of S's own.
	const update = editor.update as (patch: Partial<DecisionSelection>) => void;
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
							{editor.conflict && <ConflictBanner message={CONFLICT_ERROR} onKeepMine={editor.keepMine} onLoadSaved={editor.discard} />}
							{connections.isError ? <div className="grid justify-items-start gap-2">
								<p className="text-xs text-destructive" role="alert">Connection Settings could not be loaded.</p>
								<Button type="button" size="sm" variant="outline" onClick={() => void connections.refetch()}>Try again</Button>
							</div> : <Field label="Decision Model" helper={pickerHelper}>
								<DecisionModelPicker selection={draft} onChange={update} label={pickerLabel} />
							</Field>}
							<NumberGroup title="Decision Model state" description={stateDescription}>
								<NumberRow
									id={`${id}-state-limit`}
									label="State token limit"
									min={MIN_DECISION_STATE_TOKEN_LIMIT}
									step={1}
									value={draft.decisionStateTokenLimit}
									onChange={(decisionStateTokenLimit) => update({ decisionStateTokenLimit })}
								/>
							</NumberGroup>
							{children?.(draft)}
						</div>
					)}
				</section>
			</div>
			<SaveFooter dirty={editor.dirty} saving={editor.pending} valid={!editor.conflict} error={editor.error} onSave={() => void editor.save()} />
		</>
	);
}
