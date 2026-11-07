import { useState, type ReactNode } from "react";
import { ConnectionProfileEditor } from "./connection-settings/ConnectionProfileEditor";
import { ConnectionProfileList } from "./connection-settings/ConnectionProfileList";
import { SemanticTriggerSettingsEditor, useSemanticTriggerSettings } from "./SemanticTriggerSettingsEditor";
import { DecisionSettingsEditor, useSettingsDraft, type SettingsDraft } from "./DecisionSettingsEditor";
import { boxDecisionClients, boxDelegateClients } from "../box-decision-settings";
import { DelegateSettingsEditor } from "./DelegateSettingsEditor";
import { installedBoxes, type BoxDecisionSettings, type BoxDelegateSettings, type BoxId } from "../../shared/contract/box";
import {
	useConnectionSettingsController,
	type ConnectionSettingsController,
} from "./connection-settings/useConnectionSettingsController";

export function ConnectionSettingsPanelHost() {
	return <ConnectionSettingsPanel controller={useConnectionSettingsController()} activeProfileId={null} />;
}

type PanelProps = { controller: ConnectionSettingsController; activeProfileId: number | null };

type DecisionClient = ReturnType<typeof boxDecisionClients>[number];
type DelegateClient = ReturnType<typeof boxDelegateClients>[number];
type Owner = { readonly kind: "decision"; readonly client: DecisionClient } | { readonly kind: "delegate"; readonly client: DelegateClient };
export type Drafts = {
	readonly decisions: readonly (DecisionClient & { readonly editor: SettingsDraft<BoxDecisionSettings> })[];
	readonly delegates: readonly (DelegateClient & { readonly editor: SettingsDraft<BoxDelegateSettings> })[];
};
type Chain = { readonly owners: readonly Owner[]; readonly drafts: Drafts; readonly render: (drafts: Drafts) => ReactNode };

// @approved
//  Each digesting and delegating Box's settings draft lives in a component of
// its own, keyed by the Box, one nested in the next in the order the drafts
// first appeared, which collects the drafts for the panel. A draft that
// appears while the app runs, for a new Box or one whose new version digests
// or delegates, joins at the end, so every draft already open keeps its state
// and save guard. The panel lists them in catalog order.
function Drafted({ owners, drafts, render }: Chain) {
	const [owner, ...rest] = owners;
	if (owner === undefined) return render(drafts);
	return owner.kind === "decision"
		? <DecisionDraft key={`decision:${owner.client.box}`} client={owner.client} owners={rest} drafts={drafts} render={render} />
		: <DelegateDraft key={`delegate:${owner.client.box}`} client={owner.client} owners={rest} drafts={drafts} render={render} />;
}
function DecisionDraft({ client, ...chain }: Chain & { readonly client: DecisionClient }) {
	const editor = useSettingsDraft(`${client.label} Settings`, client.load, client.save);
	return <Drafted {...chain} drafts={{ ...chain.drafts, decisions: [...chain.drafts.decisions, { ...client, editor }] }} />;
}
function DelegateDraft({ client, ...chain }: Chain & { readonly client: DelegateClient }) {
	const editor = useSettingsDraft(`${client.label} delegate settings`, client.load, client.save);
	return <Drafted {...chain} drafts={{ ...chain.drafts, delegates: [...chain.drafts.delegates, { ...client, editor }] }} />;
}

/** @approved Every digesting and delegating Box's settings draft, in catalog order, each kept by its own component across catalog changes. */
export function BoxSettingsDrafts({ render }: { readonly render: (drafts: Drafts) => ReactNode }) {
	const [appeared] = useState<string[]>(() => []);
	const owners: Owner[] = [...boxDecisionClients().map((client) => ({ kind: "decision" as const, client })), ...boxDelegateClients().map((client) => ({ kind: "delegate" as const, client }))];
	for (const { kind, client } of owners) if (!appeared.includes(`${kind}:${client.box}`)) appeared.push(`${kind}:${client.box}`);
	owners.sort((left, right) => appeared.indexOf(`${left.kind}:${left.client.box}`) - appeared.indexOf(`${right.kind}:${right.client.box}`));
	const order = [...installedBoxes().keys()];
	const listed = <Draft extends { readonly box: BoxId }>(drafts: readonly Draft[]) => drafts.toSorted((left, right) => order.indexOf(left.box) - order.indexOf(right.box));
	return <Drafted owners={owners} drafts={{ decisions: [], delegates: [] }} render={({ decisions, delegates }) => render({ decisions: listed(decisions), delegates: listed(delegates) })} />;
}

export function ConnectionSettingsPanel({ controller, activeProfileId }: PanelProps) {
	const semanticTriggers = useSemanticTriggerSettings();
	const [open, setOpen] = useState<Open>(null);
	return <BoxSettingsDrafts render={(drafts) =>
		<Settings controller={controller} activeProfileId={activeProfileId} semanticTriggers={semanticTriggers} open={open} setOpen={setOpen} drafts={drafts} />} />;
}

type Open = "semantic-triggers" | BoxId | `delegate:${BoxId}` | null;
function Settings({ controller, activeProfileId, semanticTriggers, open, setOpen, drafts: { decisions: boxDecisions, delegates: boxDelegates } }: PanelProps & {
	semanticTriggers: ReturnType<typeof useSemanticTriggerSettings>;
	open: Open;
	setOpen: (open: Open) => void;
	drafts: Drafts;
}) {
	const openBox = boxDecisions.find(({ box }) => box === open);
	const openDelegate = boxDelegates.find(({ box }) => `delegate:${box}` === open);
	if (controller.editorOpen) return <ConnectionProfileEditor controller={controller} />;
	if (open === "semantic-triggers") return <SemanticTriggerSettingsEditor semanticTriggers={semanticTriggers} onBack={() => setOpen(null)} />;
	if (openDelegate !== undefined) return <DelegateSettingsEditor editor={openDelegate.editor} box={openDelegate.box} label={openDelegate.label} delegate={openDelegate.delegate} onBack={() => setOpen(null)} />;
	if (openBox !== undefined) {
		const { label, decision } = openBox;
		return <DecisionSettingsEditor
			editor={openBox.editor}
			id={`${openBox.box}-settings`}
			title={label}
			description={decision.description}
			pickerLabel={`${label} Decision Model`}
			pickerHelper="System One connections only."
			stateDescription={decision.context}
			onBack={() => setOpen(null)}
		/>;
	}
	return (
		<div className="panel-body settings-panel-body">
			{controller.loading ? <p className="panel-note" role="status">Loading Connections…</p>
				: controller.settings === null ? <p className="import-problem" role="alert">{controller.error}</p>
				: (
					<ConnectionProfileList
						controller={controller}
						settings={controller.settings}
						activeProfileId={activeProfileId}
						semanticTriggers={semanticTriggers}
						onOpenSemanticTrigger={() => setOpen("semantic-triggers")}
						boxDecisions={boxDecisions}
						onOpenBoxDecision={setOpen}
						boxDelegates={boxDelegates}
						onOpenBoxDelegate={(box) => setOpen(`delegate:${box}`)}
					/>
				)}
		</div>
	);
}
