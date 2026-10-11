import { useState } from "react";
import { ConnectionProfileEditor } from "./connection-settings/ConnectionProfileEditor";
import { ConnectionProfileList } from "./connection-settings/ConnectionProfileList";
import { SemanticTriggerSettingsEditor, useSemanticTriggerSettings } from "./SemanticTriggerSettingsEditor";
import { DecisionSettingsEditor, useSettingsDraft } from "./DecisionSettingsEditor";
import { loadWorldClockDecisionSettings, saveWorldClockDecisionSettings } from "../box-decision-settings";
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
	const worldClock = useSettingsDraft("World Clock Settings", loadWorldClockDecisionSettings, saveWorldClockDecisionSettings);
	const [open, setOpen] = useState<"semantic-triggers" | "world-clock" | null>(null);
	if (controller.editorOpen) return <ConnectionProfileEditor controller={controller} />;
	if (open === "semantic-triggers") return <SemanticTriggerSettingsEditor semanticTriggers={semanticTriggers} onBack={() => setOpen(null)} />;
	if (open === "world-clock") return <DecisionSettingsEditor
		editor={worldClock}
		id="world-clock-settings"
		title="World Clock"
		description="Choose a Decision Model to advance each Chat's World Clock from what its passages say. Without one, the clock stays where it is."
		pickerLabel="World Clock Decision Model"
		pickerHelper="System One connections only."
		stateDescription="Each passage is read with the Message before it."
		onBack={() => setOpen(null)}
	/>;
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
						worldClock={worldClock}
						onOpenWorldClock={() => setOpen("world-clock")}
					/>
				)}
		</div>
	);
}
