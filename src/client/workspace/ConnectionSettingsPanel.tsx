import { useState } from "react";
import { ConnectionProfileEditor } from "./connection-settings/ConnectionProfileEditor";
import { ConnectionProfileList } from "./connection-settings/ConnectionProfileList";
import { EmbeddingSettingsEditor, useEmbeddingSettings } from "./EmbeddingSettingsEditor";
import { TypesafeSettingsEditor, useTypesafeSettings } from "./TypesafeSettingsEditor";
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
	const embedding = useEmbeddingSettings();
	const [embeddingOpen, setEmbeddingOpen] = useState(false);
	const typesafe = useTypesafeSettings();
	const [typesafeOpen, setTypesafeOpen] = useState(false);
	if (controller.editorOpen) return <ConnectionProfileEditor controller={controller} />;
	if (embeddingOpen) return <EmbeddingSettingsEditor embedding={embedding} onBack={() => setEmbeddingOpen(false)} />;
	if (typesafeOpen) return <TypesafeSettingsEditor typesafe={typesafe} onBack={() => setTypesafeOpen(false)} />;
	return (
		<div className="panel-body settings-panel-body">
			{controller.loading ? <p className="panel-note" role="status">Loading Connections…</p>
				: controller.settings === null ? <p className="import-problem" role="alert">{controller.error}</p>
				: <ConnectionProfileList controller={controller} settings={controller.settings} activeProfileId={activeProfileId} embedding={embedding} onOpenEmbedding={() => setEmbeddingOpen(true)} typesafe={typesafe} onOpenTypesafe={() => setTypesafeOpen(true)} />}
		</div>
	);
}
