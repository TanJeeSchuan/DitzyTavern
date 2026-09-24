import { ShieldCheck } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { PanelHeader } from "../PanelHeader";
import { ConnectionProfileDeletion } from "./connection-settings/ConnectionProfileDeletion";
import { ConnectionProfileEditor } from "./connection-settings/ConnectionProfileEditor";
import { ConnectionProfileList } from "./connection-settings/ConnectionProfileList";
import { ConnectionSettingsInspectorBody } from "./ConnectionSettingsInspector";
import { EmbeddingSettingsEditor, type EmbeddingSettingsSaveState } from "./EmbeddingSettingsEditor";
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
	const [embeddingStatus, setEmbeddingStatus] = useState<Pick<EmbeddingSettingsSaveState, "dirty" | "pending" | "error">>({ dirty: false, pending: false, error: null });
	const embedding = useRef<EmbeddingSettingsSaveState | null>(null);
	const onEmbeddingSaveStateChange = useCallback((state: EmbeddingSettingsSaveState) => {
		embedding.current = state;
		setEmbeddingStatus({ dirty: state.dirty, pending: state.pending, error: state.error });
	}, []);
	const dirty = controller.dirty || embeddingStatus.dirty;
	const saving = controller.saving || embeddingStatus.pending;
	const save = async () => {
		if (controller.dirty && !(await controller.applyDraft())) return false;
		return !embedding.current?.dirty || await embedding.current.save();
	};
	useSaveGuard({ dirty, saving, save, discard: () => { if (controller.dirty) controller.discardDraft(); if (embedding.current?.dirty) embedding.current.discard(); } });
	const { settings } = controller;
	return (
		<><div className="panel-body settings-panel-body connection-settings-panel" data-test-connection-outcome={controller.testResult?.outcome}>
			{controller.loading ? <p>Loading Connection Settings...</p> : settings === null ? <p role="alert">{controller.error}</p> : <>
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
			</>}
			<EmbeddingSettingsEditor onSaveStateChange={onEmbeddingSaveStateChange} />
		</div><SaveFooter dirty={dirty} saving={saving} valid={!controller.dirty || controller.canSave} error={controller.error ?? embeddingStatus.error} onSave={() => void save()} /></>
	);
}
