import { useState } from "react";
import { ConnectionProfileEditor } from "./connection-settings/ConnectionProfileEditor";
import { ConnectionProfileList } from "./connection-settings/ConnectionProfileList";
import { SemanticTriggerSettingsEditor, useSemanticTriggerSettings } from "./SemanticTriggerSettingsEditor";
import { DecisionSettingsEditor, useSettingsDraft } from "./DecisionSettingsEditor";
import { boxDecisionClients } from "../box-decision-settings";
import { boxDescriptors, type DigestBoxId } from "../../shared/contract/box";
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
	const boxDecisions = boxDecisionClients.map(({ box, load, save }) => ({ box, editor: useSettingsDraft(`${boxDescriptors[box].label} Settings`, load, save) }));
	const [open, setOpen] = useState<"semantic-triggers" | DigestBoxId | null>(null);
	const openBox = boxDecisions.find(({ box }) => box === open);
	if (controller.editorOpen) return <ConnectionProfileEditor controller={controller} />;
	if (open === "semantic-triggers") return <SemanticTriggerSettingsEditor semanticTriggers={semanticTriggers} onBack={() => setOpen(null)} />;
	if (openBox !== undefined) {
		const { label, decision } = boxDescriptors[openBox.box];
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
