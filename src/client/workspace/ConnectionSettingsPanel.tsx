import { useState } from "react";
import { ConnectionProfileEditor } from "./connection-settings/ConnectionProfileEditor";
import { ConnectionProfileList } from "./connection-settings/ConnectionProfileList";
import { SemanticTriggerSettingsEditor, useSemanticTriggerSettings } from "./SemanticTriggerSettingsEditor";
import { DecisionSettingsEditor, useSettingsDraft } from "./DecisionSettingsEditor";
import { boxDecisionClients, boxDelegateClients } from "../box-decision-settings";
import { DelegateSettingsEditor } from "./DelegateSettingsEditor";
import type { BoxId } from "../../shared/contract/box";
import {
	useConnectionSettingsController,
	type ConnectionSettingsController,
} from "./connection-settings/useConnectionSettingsController";

export function ConnectionSettingsPanelHost() {
	return <ConnectionSettingsPanel controller={useConnectionSettingsController()} activeProfileId={null} />;
}

type PanelProps = { controller: ConnectionSettingsController; activeProfileId: number | null };

// @approved
//  Each digesting and delegating Box has a settings draft, a hook, so a Box
// the catalog gains or loses remounts the panel and the hooks keep their
// order.
export function ConnectionSettingsPanel(props: PanelProps) {
	const boxes = [...boxDecisionClients().map(({ box }) => box), ...boxDelegateClients().map(({ box }) => `delegate:${box}`)].join(" ");
	return <BoxSettingsPanel key={boxes} {...props} />;
}

function BoxSettingsPanel({ controller, activeProfileId }: PanelProps) {
	const semanticTriggers = useSemanticTriggerSettings();
	const boxDecisions = boxDecisionClients().map(({ box, label, decision, load, save }) => ({ box, label, decision, editor: useSettingsDraft(`${label} Settings`, load, save) }));
	const boxDelegates = boxDelegateClients().map(({ box, label, delegate, load, save }) => ({ box, label, delegate, editor: useSettingsDraft(`${label} delegate settings`, load, save) }));
	const [open, setOpen] = useState<"semantic-triggers" | BoxId | `delegate:${BoxId}` | null>(null);
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
