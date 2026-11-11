import { useId } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ConflictBanner } from "../ConflictBanner";
import { ProfileModelPicker } from "../ProfileModelPicker";
import { SaveFooter } from "../SaveFooter";
import { useNavigationRequest, useSaveGuard } from "../SaveGuard";
import type { ModelSelectionSettings } from "../../shared/contract/model-selection";
import type { SettingsDraft } from "./DecisionSettingsEditor";

export function ModelSelectionSettingsEditor({ editor, onBack, label, description, apiFormat }: {
	editor: SettingsDraft<ModelSelectionSettings>;
	onBack: () => void;
	label: string;
	description: string;
	apiFormat: "images" | "chat-completions";
}) {
	const title = useId();
	const navigate = useNavigationRequest();
	useSaveGuard({ dirty: editor.dirty, saving: editor.pending, save: editor.save, discard: editor.discard });
	const { draft } = editor;
	return <>
		<div className="panel-body settings-panel-body">
			<Button className="-ml-2 mb-3 text-muted-foreground" size="sm" variant="ghost" onClick={() => navigate(onBack)}><ChevronLeft aria-hidden="true" /> Connections</Button>
			<section className="mt-4" aria-labelledby={title}>
				<h3 id={title} className="text-base! font-semibold">{label}</h3>
				<p>{description}</p>
				{draft === null ? <>
					{editor.loading ? <p role="status">Loading {label}…</p> : <p role="alert" className="text-sm text-destructive">{editor.error}</p>}
					{!editor.loading && <Button variant="outline" onClick={editor.reload}>Try again</Button>}
				</> : <>
					{editor.conflict && <ConflictBanner message={`The ${label} changed elsewhere. Review your selection before saving again.`} onKeepMine={editor.keepMine} onLoadSaved={editor.discard} />}
					<Field label={label} helper={`${apiFormat === "images" ? "Images" : "Chat Completions"} connections only.`}>
						<ProfileModelPicker apiFormat={apiFormat} label={label} emptyLabel={`Add a ${apiFormat === "images" ? "Images" : "Chat Completions"} connection in Connections.`} selected={draft.profileId === null ? null : { connectionProfileId: draft.profileId, modelId: draft.model }} onSelect={(profile, model) => editor.update({ profileId: profile.id, model })} />
					</Field>
					{draft.profileId !== null && <Button className="mt-3" size="sm" variant="outline" onClick={() => editor.update({ profileId: null, model: "" })}>Turn off</Button>}
				</>}
			</section>
		</div>
		<SaveFooter dirty={editor.dirty} saving={editor.pending} valid={!editor.conflict} error={editor.error} onSave={() => void editor.save()} />
	</>;
}
