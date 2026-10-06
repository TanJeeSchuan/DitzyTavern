import { useState } from "react";
import { ConnectionProfileEditor } from "./connection-settings/ConnectionProfileEditor";
import { ConnectionProfileList } from "./connection-settings/ConnectionProfileList";
import { SemanticTriggerSettingsEditor, useSemanticTriggerSettings } from "./SemanticTriggerSettingsEditor";
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
	const [semanticTriggersOpen, setSemanticTriggersOpen] = useState(false);
	if (controller.editorOpen) return <ConnectionProfileEditor controller={controller} />;
	if (semanticTriggersOpen) return <SemanticTriggerSettingsEditor semanticTriggers={semanticTriggers} onBack={() => setSemanticTriggersOpen(false)} />;
	return (
		<div className="panel-body settings-panel-body">
			{controller.loading ? <p className="panel-note" role="status">Loading Connections…</p>
				: controller.settings === null ? <p className="import-problem" role="alert">{controller.error}</p>
				: <ConnectionProfileList controller={controller} settings={controller.settings} activeProfileId={activeProfileId} semanticTriggers={semanticTriggers} onOpenSemanticTrigger={() => setSemanticTriggersOpen(true)} />}
		</div>
	);
}
