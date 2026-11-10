import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ConflictBanner } from "../ConflictBanner";
import { ProfileModelPicker } from "../ProfileModelPicker";
import { SaveFooter } from "../SaveFooter";
import { useNavigationRequest, useSaveGuard } from "../SaveGuard";
import type { BoxDelegateSettings, BoxId } from "../../shared/contract/box";
import type { SettingsDraft } from "./DecisionSettingsEditor";

// @approved
//  A delegating Box's delegate setting: the Chat Completions profile and
// model its agent runs on, or the host default. It saves as the Decision Model settings
// beside it do, under its own revision.
export function DelegateSettingsEditor({ editor, box, label, description, off, inherited, onBack }: {
	editor: SettingsDraft<BoxDelegateSettings>;
	box: BoxId;
	label: string;
	description: string;
	off: string;
	inherited: boolean;
	onBack: () => void;
}) {
	const navigate = useNavigationRequest();
	useSaveGuard({ dirty: editor.dirty, saving: editor.pending, save: editor.save, discard: editor.discard });
	const { draft } = editor;
	const id = `${box}-delegate`;
	return (
		<>
			<div className="panel-body settings-panel-body">
				<Button type="button" size="sm" variant="ghost" className="-ml-2 mb-3 text-muted-foreground" onClick={() => navigate(onBack)}><ChevronLeft aria-hidden="true" /> Connections</Button>
				<section aria-labelledby={`${id}-title`}>
					<h3 id={`${id}-title`} className="text-base! font-semibold">{label} delegate</h3>
					<p>{description}</p>
					{draft === null ? (
						<div className="grid justify-items-start gap-2">
							<p className="text-xs text-destructive" role="alert">{editor.error ?? `${label} delegate settings could not be loaded.`}</p>
							<Button type="button" size="sm" variant="outline" onClick={editor.reload}>Try again</Button>
						</div>
					) : (
						<div className="grid gap-4">
							{editor.conflict && <ConflictBanner message="These settings changed elsewhere. Review your draft before saving again." onKeepMine={editor.keepMine} onLoadSaved={editor.discard} />}
							<Field label="Delegate model" helper={draft.profileId === null ? off : "Chat Completions connections only."}>
								<ProfileModelPicker label={`${label} delegate model`} emptyLabel="Add a Chat Completions connection in Connections."
									selected={draft.profileId === null ? null : { connectionProfileId: draft.profileId, modelId: draft.model }}
									onSelect={(profile, model) => editor.update({ profileId: profile.id, model })} />
							</Field>
							{draft.profileId !== null && <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => editor.update({ profileId: null, model: "" })}>{inherited ? "Use default" : "Turn off"}</Button>}
						</div>
					)}
				</section>
			</div>
			<SaveFooter dirty={editor.dirty} saving={editor.pending} valid={!editor.conflict} error={editor.error} onSave={() => void editor.save()} />
		</>
	);
}
