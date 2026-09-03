import { PanelHeader } from "../PanelHeader";
import { ConnectionProfileAdvancedEditor } from "./connection-settings/ConnectionProfileAdvancedEditor";
import type { ConnectionSettingsController } from "./connection-settings/useConnectionSettingsController";

export function ConnectionSettingsInspector({
	controller,
	onClose,
}: {
	controller: ConnectionSettingsController;
	onClose: () => void;
}) {
	return (
		<aside className="details-panel split-inspector" data-open="true" aria-label="Connection Settings inspector">
			<PanelHeader
				title="Connection Settings inspector"
				backLabel="Back to Connection Settings"
				onClose={onClose}
			/>
			<ConnectionSettingsInspectorBody controller={controller} />
		</aside>
	);
}

export function ConnectionSettingsInspectorBody({
	controller,
}: {
	controller: ConnectionSettingsController;
}) {
	return (
		<div className="panel-body settings-panel-body">
			{controller.loading && <p className="panel-note" role="status">Loading Connection Settings...</p>}
			{!controller.loading && controller.settings === null && <p className="import-problem" role="alert">{controller.error}</p>}
			{!controller.loading && controller.settings !== null && (
				<div className="definition-form">
					<ConnectionProfileAdvancedEditor controller={controller} />
				</div>
			)}
		</div>
	);
}
