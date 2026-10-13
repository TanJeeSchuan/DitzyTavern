import { useState } from "react";
import { ConnectionProfileEditor } from "./connection-settings/ConnectionProfileEditor";
import { ConnectionProfileList } from "./connection-settings/ConnectionProfileList";
import { SemanticTriggerSettingsEditor, useSemanticTriggerSettings } from "./SemanticTriggerSettingsEditor";
import { DecisionSettingsEditor, useSettingsDraft } from "./DecisionSettingsEditor";
import { boxDecisionClients } from "../box-decision-settings";
import type { BoxId } from "../../shared/contract/box";
import {
	useConnectionSettingsController,
	type ConnectionSettingsController,
} from "./connection-settings/useConnectionSettingsController";

export function ConnectionSettingsPanelHost() {
	return <ConnectionSettingsPanel controller={useConnectionSettingsController()} activeProfileId={null} />;
}

export function ConnectionSettingsPanel({
	controller,
	activeProfileId,
}: {
	controller: ConnectionSettingsController;
	activeProfileId: number | null;
}) {
	const semanticTriggers = useSemanticTriggerSettings();
	// @approved
	//  boxDecisionClients never changes, so these drafts keep their hook order.
	const boxDecisions = boxDecisionClients.map(({ box, label, decision, load, save }) => ({ box, label, decision, editor: useSettingsDraft(`${label} Settings`, load, save) }));
	const [open, setOpen] = useState<"semantic-triggers" | BoxId | null>(null);
	const openBox = boxDecisions.find(({ box }) => box === open);
	if (controller.editorOpen) return <ConnectionProfileEditor controller={controller} />;
	if (open === "semantic-triggers") return <SemanticTriggerSettingsEditor semanticTriggers={semanticTriggers} onBack={() => setOpen(null)} />;
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
					/>
				)}
		</div>
	);
}
