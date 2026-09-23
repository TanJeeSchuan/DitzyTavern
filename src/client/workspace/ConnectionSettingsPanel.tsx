import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { PanelHeader } from "../PanelHeader";
import { ConnectionProfileDeletion } from "./connection-settings/ConnectionProfileDeletion";
import { ConnectionProfileEditor } from "./connection-settings/ConnectionProfileEditor";
import { ConnectionProfileList } from "./connection-settings/ConnectionProfileList";
import { ConnectionSettingsInspectorBody } from "./ConnectionSettingsInspector";
import { SaveFooter } from "../SaveFooter";
import { useSaveGuard, useSaveNavigation } from "../SaveGuard";
import {
	useConnectionSettingsController,
	type ConnectionSettingsController,
} from "./connection-settings/useConnectionSettingsController";

export function ConnectionSettingsPanelHost() {
	const controller = useConnectionSettingsController();
	const [inspectorOpen, setInspectorOpen] = useState(false);
	return (
		<div className="connection-settings-host">
			<ConnectionSettingsPanel controller={controller} onOpenInspector={() => setInspectorOpen(true)} />
			{inspectorOpen && (
				<section className="connection-standalone-inspector" aria-label="Connection Settings inspector">
					<PanelHeader title="Connection Settings inspector" backLabel="Back to Connection Settings" onClose={() => setInspectorOpen(false)} />
					<ConnectionSettingsInspectorBody controller={controller} />
				</section>
			)}
		</div>
	);
}

export function ConnectionSettingsPanel({
	controller,
	onOpenInspector,
}: {
	controller: ConnectionSettingsController;
	onOpenInspector: () => void;
}) {
	const navigate = useSaveNavigation();
	useSaveGuard({ dirty: controller.dirty, saving: controller.saving, save: controller.applyDraft, discard: controller.discardDraft });
	if (controller.loading) return <div className="panel-body settings-panel-body">Loading Connection Settings...</div>;
	if (!controller.settings) return <div className="panel-body settings-panel-body" role="alert">{controller.error}</div>;

	const { settings } = controller;
	return (
		<><div className="panel-body settings-panel-body connection-settings-panel" data-test-connection-outcome={controller.testResult?.outcome}>
			<ConnectionProfileList
				settings={settings}
				presets={controller.presets}
				selectedProfileId={controller.selectedProfileId}
				presetChoicesOpen={controller.presetChoicesOpen}
				openProfileMenuId={controller.openProfileMenuId}
				onChooseProfile={(profile) => navigate(() => controller.chooseProfile(profile))}
				onRequestDeletion={controller.requestProfileDeletion}
				onTogglePresets={() => controller.setPresetChoicesOpen(!controller.presetChoicesOpen)}
				onToggleProfileMenu={controller.setOpenProfileMenuId}
				onChoosePreset={(preset) => navigate(() => controller.choosePreset(preset))}
			/>

			{controller.pendingDeletionProfile && (
				<ConnectionProfileDeletion
					profile={controller.pendingDeletionProfile}
					onCancel={() => controller.setPendingDeletionProfileId(null)}
					onDelete={() => void controller.deletePendingProfile()}
				/>
			)}

			{controller.editorOpen && <ConnectionProfileEditor controller={controller} onOpenInspector={onOpenInspector} />}

			{(controller.notice || controller.error || controller.conflict) && (
				<p className={controller.error ? "connection-feedback connection-feedback-error" : "connection-feedback"} role={controller.error ? "alert" : "status"}>
					{controller.error ?? controller.notice}
					{controller.conflict && <small> The settings changed elsewhere. Your draft is still here. Review it before saving again.</small>}
				</p>
			)}
			<div className="connection-security-note"><ShieldCheck aria-hidden="true" /><span>Credentials and custom headers are stored separately from Conversation data and are never shown after saving.</span></div>
		</div>{controller.editorOpen && <SaveFooter dirty={controller.dirty} saving={controller.saving} valid={controller.canSave} error={controller.error} onSave={() => void controller.applyDraft()} />}</>
	);
}
