import type { JsonData } from "json-edit-react";
import type { ConversationGenerationSettings, ConversationSummary } from "../conversation";
import type { OverridesDrafts, OverridesNamespace } from "../generation-settings-draft";
import { PanelHeader } from "../PanelHeader";
import { RequestOverridesEditor } from "./GenerationSettingsEditors";
import type { GenerationSettingsDraftStatus, TransmittingNamespace } from "./useGenerationSettingsDraft";

/** @approved The Generation Settings the Request Overrides inspector reads and its one write. */
type GenerationOverridesInspector = {
	settings: ConversationGenerationSettings | null;
	status: GenerationSettingsDraftStatus;
	overridesDrafts: OverridesDrafts;
	updateOverrides: (namespace: OverridesNamespace, value: JsonData) => void;
	transmittingNamespace: TransmittingNamespace;
};

export function GenerationSettingsInspector({
	conversation,
	controller,
	onClose,
}: {
	conversation: ConversationSummary | null;
	controller: GenerationOverridesInspector;
	onClose: () => void;
}) {
	return (
		<aside className="details-panel split-inspector" data-open="true" aria-label="Request Overrides">
			<PanelHeader
				title="Request Overrides"
				backLabel="Back to Generation Settings"
				onClose={onClose}
			/>
			<div className="panel-body settings-panel-body">
				{conversation === null && <p className="panel-note">Open a Chat to edit its Generation settings.</p>}
				{controller.status === "load-error" && (
					<p className="import-problem" role="alert">Generation Settings could not be loaded.</p>
				)}
				{controller.settings !== null && controller.status !== "load-error" && (
					<div className="definition-form">
						<RequestOverridesEditor drafts={controller.overridesDrafts} onChange={controller.updateOverrides} transmittingNamespace={controller.transmittingNamespace} />
					</div>
				)}
			</div>
		</aside>
	);
}
