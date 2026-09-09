import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { ConversationSummary } from "../conversation";
import { PromptPresetLibrarySection } from "./prompt-preset/PromptPresetLibrarySection";
import { PromptPresetRecipeEditor } from "./prompt-preset/PromptPresetRecipeEditor";
import { PromptPresetImportReviewDialog } from "./prompt-preset/PromptPresetImportReviewDialog";
import { UnsavedBlockEditDialog } from "./prompt-preset/UnsavedBlockEditDialog";
import { usePromptPresetEditor } from "./prompt-preset/usePromptPresetEditor";

// ==[HUMAN APPROVED]== The preset editor is a popup rather than a primary panel: the agreed
// exception in the design direction, because a recipe is edited against the
// Chat it assembles for. The library section manages the shared presets and
// the per-Chat selection; ordering and enablement persist immediately through
// their authoritative operations. Referenced source text is read-only here —
// it belongs to the Participant it comes from — while an authored instruction
// block owns its name, text, and outgoing role, each one a per-block draft
// with its own Save and Cancel. The history slot exposes no text or role
// controls at all, because its entries keep the roles of their own Messages.
// The controller hook owns the async work and the editor state module owns
// the response-ownership and draft-reconciliation rules; this dialog only
// composes them.

export function PromptPresetDialog({
	conversation,
	onConversationChange,
	open,
	onOpenChange,
}: {
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const editor = usePromptPresetEditor({ conversation, open, onConversationChange, onOpenChange });
	const ready = editor.view.status === "ready" ? editor.view : null;

	return (
		<>
		<Dialog open={open} onOpenChange={editor.requestOpenChange}>
			<DialogContent
				className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
				onEscapeKeyDown={editor.guardDirtyDismiss}
				onInteractOutside={editor.guardDirtyDismiss}
			>
				<DialogHeader>
					<DialogTitle>
						{ready !== null ? `Prompt Preset: ${ready.selected.name}` : "Prompt Preset"}
					</DialogTitle>
					<DialogDescription>
						Shared recipes live in one library and each Chat selects one. Ordering
						and enablement save immediately; referenced content is read-only here,
						edited on the Participant it comes from. Authored instruction text
						saves per block.
					</DialogDescription>
				</DialogHeader>
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
							onSelect={editor.selectPreset}
							onCommand={(command, successNotice) => void editor.runPresetCommand(command, successNotice)}
							onImportFile={(file) => void editor.importPresetFile(file)}
							onExport={(presetId, name) => void editor.exportSelectedPreset(presetId, name)}
						/>
						<PromptPresetRecipeEditor
							preset={ready.selected}
							drafts={editor.drafts}
							pending={editor.busy}
							problem={editor.problem}
							onDraftChange={editor.setDraft}
							onDraftCancel={editor.clearDraft}
							onOperation={(run, submitted) => void editor.runRecipeOperation(run, submitted)}
						/>
					</>
				)}
				{editor.notice !== null && (
					<p className="text-sm text-muted-foreground" role="status">
						{editor.notice}
					</p>
				)}
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
			</DialogContent>
		</Dialog>
		<PromptPresetImportReviewDialog
			review={editor.review}
			busy={editor.busy}
			onOrderSelect={(orderListId) => void editor.selectSillyTavernOrder(orderListId)}
			onCancel={editor.cancelSillyTavernReview}
			onCommit={() => void editor.commitSillyTavernReview()}
		/>
		</>
	);
}
