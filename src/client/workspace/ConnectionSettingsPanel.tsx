import { ShieldCheck } from "lucide-react";
import { ConnectionProfileDeletion } from "./connection-settings/ConnectionProfileDeletion";
import { ConnectionProfileEditor } from "./connection-settings/ConnectionProfileEditor";
import { ConnectionProfileList } from "./connection-settings/ConnectionProfileList";
import { useConnectionSettingsController } from "./connection-settings/useConnectionSettingsController";

export function ConnectionSettingsPanel() {
	const controller = useConnectionSettingsController();
	if (controller.loading) return <div className="panel-body settings-panel-body">Loading Connection Settings...</div>;
	if (!controller.settings) return <div className="panel-body settings-panel-body" role="alert">{controller.error}</div>;

	const { settings } = controller;
	return (
		<div className="panel-body settings-panel-body connection-settings-panel" data-test-connection-outcome={controller.testResult?.outcome}>
			<ConnectionProfileList
				settings={settings}
				presets={controller.presets}
				selectedProfileId={controller.selectedProfileId}
				presetChoicesOpen={controller.presetChoicesOpen}
				openProfileMenuId={controller.openProfileMenuId}
				onChooseProfile={controller.chooseProfile}
				onRequestDeletion={controller.requestProfileDeletion}
				onTogglePresets={() => controller.setPresetChoicesOpen(!controller.presetChoicesOpen)}
				onToggleProfileMenu={controller.setOpenProfileMenuId}
				onChoosePreset={controller.choosePreset}
			/>

			{controller.pendingDeletionProfile && (
				<ConnectionProfileDeletion
					profile={controller.pendingDeletionProfile}
					settings={settings}
					replacementProfileId={controller.replacementProfileId}
					onReplacementChange={controller.setReplacementProfileId}
					onCancel={() => controller.setPendingDeletionProfileId(null)}
					onDelete={() => void controller.deletePendingProfile()}
				/>
			)}

			{(controller.selectedProfile !== undefined || controller.draft.displayName.length > 0) && <ConnectionProfileEditor controller={controller} />}

			{(controller.notice || controller.error || controller.conflict) && (
				<p className={controller.error ? "connection-feedback connection-feedback-error" : "connection-feedback"} role={controller.error ? "alert" : "status"}>
					{controller.error ?? controller.notice}
					{controller.conflict && <small> The settings changed elsewhere. Your draft is still here. Review it before saving again.</small>}
				</p>
			)}
			<div className="connection-security-note"><ShieldCheck aria-hidden="true" /><span>Credentials and custom headers are stored separately from Conversation data and are never shown after saving.</span></div>
		</div>
	);
}
