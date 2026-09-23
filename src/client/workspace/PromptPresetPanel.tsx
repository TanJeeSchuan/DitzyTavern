import type { ConversationSummary } from "../conversation";
import { PanelHeader } from "../PanelHeader";
import { SaveFooter } from "../SaveFooter";
import { useSaveGuard } from "../SaveGuard";
import { PromptPresetLibrarySection } from "./prompt-preset/PromptPresetLibrarySection";
import { PromptPresetRecipeEditor } from "./prompt-preset/PromptPresetRecipeEditor";
import { PromptPresetImportReviewDialog } from "./prompt-preset/PromptPresetImportReviewDialog";
import { UnsavedBlockEditDialog } from "./prompt-preset/UnsavedBlockEditDialog";
import { usePromptPresetEditor } from "./prompt-preset/usePromptPresetEditor";

// ==[HUMAN APPROVED]== Prompt Presets are first-order Chat configuration and live in the
// primary side panel. The library manages shared presets and the per-Chat selection;
// ordering and enablement persist immediately through their authoritative operations.
// Referenced source text remains read-only here, while authored instruction blocks own
// per-block drafts that the panel footer saves together. Focused import review and unsaved-edit choices
// remain dialogs above the panel.
export function PromptPresetPanel({
	conversation,
	onConversationChange,
	onClose,
	mutationsDisabled = false,
}: {
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	onClose: () => void;
	mutationsDisabled?: boolean;
}) {
	const editor = usePromptPresetEditor({
		conversation,
		onConversationChange,
		onClose,
	});
	const ready = editor.view.status === "ready" ? editor.view : null;
	useSaveGuard({ dirty: editor.dirtyCount > 0, saving: editor.busy, save: editor.save, discard: () => undefined });

	return (
		<>
			<PanelHeader
				title="Prompt Presets"
				onClose={editor.requestClose}
			/>
			<div
				className="panel-body flex flex-col gap-6"
				inert={mutationsDisabled || undefined}
				aria-disabled={mutationsDisabled}
			>
				{editor.view.status === "loading" && (
					<div role="status">
						<span className="sr-only">Loading the Prompt Preset library…</span>
						<ol aria-hidden="true" className="flex flex-col gap-3">
							{Array.from({ length: 4 }, (_, index) => (
								<li
									key={index}
									className="h-16 animate-pulse rounded-lg bg-muted/50 ring-1 ring-foreground/10"
								/>
							))}
						</ol>
					</div>
				)}
				{editor.view.status === "unavailable" && (
					<p className="text-muted-foreground">
						The Prompt Preset library could not be loaded.
					</p>
				)}
				{ready !== null && (
					<>
						<PromptPresetLibrarySection
							presets={ready.presets}
							selectedId={ready.selected.id}
							pending={editor.busy}
							problem={editor.problem}
							notice={editor.notice}
							onSelect={editor.selectPreset}
							onCommand={(command, successNotice) =>
								void editor.runPresetCommand(command, successNotice)
							}
							onImportFile={(file) => void editor.importPresetFile(file)}
							onExport={(presetId, name) =>
								void editor.exportSelectedPreset(presetId, name)
							}
						/>
						<PromptPresetRecipeEditor
							preset={ready.selected}
							drafts={editor.drafts}
							pending={editor.busy}
							problem={editor.problem}
							onDraftChange={editor.setDraft}
							onDraftCancel={editor.clearDraft}
							onOperation={(run, submitted) =>
								void editor.runRecipeOperation(run, submitted)
							}
						/>
					</>
				)}
				{editor.notice !== null && (
					<p className="text-sm text-muted-foreground" role="status">
						{editor.notice}
					</p>
				)}
			</div>
			{ready !== null && <SaveFooter dirty={editor.dirtyCount > 0} saving={editor.busy} error={editor.problem} onSave={() => void editor.save()} />}
			{ready !== null && editor.leaveRequest !== null && (
				<UnsavedBlockEditDialog
					open
					count={editor.dirtyCount}
					kind={editor.leaveRequest.kind}
					onKeepEditing={editor.keepEditing}
					onDiscard={editor.discardAndLeave}
					onSave={editor.saveAndLeave}
				/>
			)}
			<PromptPresetImportReviewDialog
				review={editor.review}
				busy={editor.busy}
				onOrderSelect={(orderListId) =>
					void editor.selectSillyTavernOrder(orderListId)
				}
				onCancel={editor.cancelSillyTavernReview}
				onCommit={() => void editor.commitSillyTavernReview()}
			/>
		</>
	);
}
