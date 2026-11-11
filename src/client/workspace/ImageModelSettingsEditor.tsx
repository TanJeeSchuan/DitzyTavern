import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ConflictBanner } from "../ConflictBanner";
import { ProfileModelPicker } from "../ProfileModelPicker";
import { SaveFooter } from "../SaveFooter";
import { useNavigationRequest, useSaveGuard } from "../SaveGuard";
import type { ImageModelSettings } from "../../shared/contract/image-model";
import type { SettingsDraft } from "./DecisionSettingsEditor";

export function ImageModelSettingsEditor({ editor, onBack }: { editor: SettingsDraft<ImageModelSettings>; onBack: () => void }) {
	const navigate = useNavigationRequest();
	useSaveGuard({ dirty: editor.dirty, saving: editor.pending, save: editor.save, discard: editor.discard });
	const { draft } = editor;
	return <>
		<div className="panel-body settings-panel-body">
			<Button className="-ml-2 mb-3 text-muted-foreground" size="sm" variant="ghost" onClick={() => navigate(onBack)}><ChevronLeft aria-hidden="true" /> Connections</Button>
			<section className="mt-4" aria-labelledby="image-model-title">
				<h3 id="image-model-title" className="text-base! font-semibold">Image Model</h3>
				<p>Paints Illustrations in every Chat.</p>
				{draft === null ? <>
					{editor.loading ? <p role="status">Loading Image Model…</p> : <p role="alert" className="text-sm text-destructive">{editor.error}</p>}
					{!editor.loading && <Button variant="outline" onClick={editor.reload}>Try again</Button>}
				</> : <>
					{editor.conflict && <ConflictBanner message="The Image Model changed elsewhere. Review your selection before saving again." onKeepMine={editor.keepMine} onLoadSaved={editor.discard} />}
					<Field label="Image Model" helper="Images connections only.">
						<ProfileModelPicker apiFormat="images" label="Image Model" emptyLabel="Add an Images connection in Connections." selected={draft.profileId === null ? null : { connectionProfileId: draft.profileId, modelId: draft.model }} onSelect={(profile, model) => editor.update({ profileId: profile.id, model })} />
					</Field>
					{draft.profileId !== null && <Button className="mt-3" size="sm" variant="outline" onClick={() => editor.update({ profileId: null, model: "" })}>Turn off</Button>}
				</>}
			</section>
		</div>
		<SaveFooter dirty={editor.dirty} saving={editor.pending} valid={!editor.conflict} error={editor.error} onSave={() => void editor.save()} />
	</>;
}
