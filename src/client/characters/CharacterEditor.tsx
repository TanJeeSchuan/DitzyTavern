import { MoreHorizontal, Pin, Plus, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
	applyCommand,
	getCharacter,
	type CharacterCommand,
	type CharacterSnapshot,
} from "../character-library";
import { deletionConfirmationCopy, deletionResultNotice, usedCountLabel } from "../character-delete";
import { LIBRARY_UNREACHABLE_NOTICE } from "../character-library";
import { useAsyncEffect } from "../lib/use-async";
import { LoreAttachmentEditor } from "../lorebook/LoreAttachmentEditor";
import { useSaveGuard } from "../SaveGuard";
import { useRevisionedDraft, type DraftSaveResult } from "../lib/revisioned-draft";
import { ConflictBanner } from "../ConflictBanner";
import { DefinitionEditor, definitionOf, sameDefinition, submittableDefinition } from "./DefinitionEditor";
import type { ParticipantDefinition } from "../../shared/contract/conversation-schema";

export function CharacterEditor({
	characterId,
	autoSelectName,
	canAddToChat,
	onAddToChat,
	onChanged,
	onClosed,
}: {
	characterId: number;
	autoSelectName: boolean;
	canAddToChat: boolean;
	onAddToChat: (character: CharacterSnapshot) => void;
	onChanged: () => void;
	onClosed: (notice: string | null) => void;
}) {
	const [snapshot, setSnapshot] = useState<CharacterSnapshot | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [pendingAction, setPendingAction] = useState<"save" | "pin" | "delete" | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);

	useAsyncEffect((isCancelled) => {
		void getCharacter(characterId).then((loaded) => {
			if (isCancelled()) return;
			if (loaded === null) return onClosed("That Character is no longer in the Library.");
			setSnapshot(loaded);
		}, () => { if (!isCancelled()) onClosed(LIBRARY_UNREACHABLE_NOTICE); });
	}, [characterId]);

	/** @approved Runs one Character command; resolves the Character it left, or the one it lost to. */
	const run = useCallback(async (action: "save" | "pin" | "delete", command: CharacterCommand): Promise<{ applied: CharacterSnapshot } | { conflict: CharacterSnapshot } | null> => {
		setPendingAction(action);
		try {
			const outcome = await applyCommand(command);
			switch (outcome.outcome) {
				case "available": {
					const applied = outcome.value;
					if ("result" in applied) {
						onChanged();
						onClosed(deletionResultNotice(applied.result));
						return null;
					}
					setSnapshot(applied.character);
					setNotice(null);
					onChanged();
					return { applied: applied.character };
				}
				case "conflict":
					// @approved
					//  A pin or delete that lost has loaded the change, so trying again applies.
					setSnapshot(outcome.currentCharacter);
					if (action !== "save") setNotice("This Character changed elsewhere. Try again.");
					return { conflict: outcome.currentCharacter };
				case "not-found":
					onChanged();
					onClosed("That Character is no longer in the Library.");
					return null;
				case "invalid":
				case "unusable":
					setNotice(outcome.reason);
					return null;
				default:
					setNotice(LIBRARY_UNREACHABLE_NOTICE);
					return null;
			}
		} catch (cause) {
			setNotice(cause instanceof Error ? cause.message : LIBRARY_UNREACHABLE_NOTICE);
			return null;
		} finally {
			setPendingAction(null);
		}
	}, [onChanged, onClosed]);

	const revisioned = (character: CharacterSnapshot) => ({ value: definitionOf(character), revision: character.revision });
	const editor = useRevisionedDraft(snapshot === null ? null : revisioned(snapshot), {
		equals: sameDefinition,
		save: async (submitted, expectedRevision): Promise<DraftSaveResult<ParticipantDefinition>> => {
			const result = await run("save", { type: "update-definition", characterId, expectedRevision, definition: submittableDefinition(submitted) });
			if (result === null) return { outcome: "failed" };
			return "applied" in result ? { outcome: "saved", saved: revisioned(result.applied) } : { outcome: "conflict", theirs: revisioned(result.conflict) };
		},
	});
	const draft = editor.value;
	useSaveGuard({ dirty: editor.dirty, saving: editor.saving, save: editor.save, discard: editor.discard });
	if (snapshot === null || draft === null) return <p className="panel-body text-sm text-muted-foreground" role="status">Loading the Character…</p>;
	const deleteCopy = deletionConfirmationCopy(snapshot.name, snapshot.deletionImpact);

	return (
		<>
			<DefinitionEditor
				draft={draft}
				onDraftChange={editor.edit}
				subtitle={`Library Character · ${usedCountLabel(snapshot.deletionImpact.provenanceReferenceCount)}`}
				dirty={editor.dirty}
				saving={editor.saving}
				error={notice}
				valid={!editor.conflict}
				autoSelectName={autoSelectName}
				onSave={() => void editor.save()}
				onBack={() => onClosed(null)}
				actions={<>
					<Button
						type="button"
						size="icon-sm"
						variant="ghost"
						className="text-muted-foreground aria-pressed:text-foreground"
						aria-pressed={snapshot.pinned}
						aria-label={snapshot.pinned ? "Unpin" : "Pin to the top of the Library"}
						title={snapshot.pinned ? "Pinned" : "Pin"}
						disabled={pendingAction !== null}
						onClick={() =>
							void run("pin", {
								type: "set-pinned",
								characterId: snapshot.id,
								expectedRevision: snapshot.revision,
								pinned: !snapshot.pinned,
							})
						}
						>
						<Pin aria-hidden="true" className={snapshot.pinned ? "fill-current" : undefined} />
					</Button>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" size="icon-sm" variant="ghost" aria-label={`Actions for ${snapshot.name}`} disabled={pendingAction !== null}>
								<MoreHorizontal aria-hidden="true" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-48">
							<DropdownMenuItem disabled={!canAddToChat} onSelect={() => onAddToChat(snapshot)}><Plus aria-hidden="true" /> Add to this Chat</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDelete(true)}><Trash2 aria-hidden="true" /> Delete Character</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</>}
				banner={editor.conflict && <ConflictBanner
					message="This Character changed elsewhere after you opened it. Your edits were not saved and are still here."
					onKeepMine={editor.keepMine}
					onLoadSaved={editor.discard}
				/>}
			>
				<LoreAttachmentEditor owner="character" ownerId={snapshot.id} disabled={pendingAction !== null} />
			</DefinitionEditor>
			<Dialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
				<DialogContent showCloseButton={false} className="sm:max-w-sm">
					<DialogHeader>
						<DialogTitle>{deleteCopy.title}</DialogTitle>
						<DialogDescription>{deleteCopy.impact}</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={() => setConfirmingDelete(false)}>Keep Character</Button>
						<Button
							type="button"
							variant="destructive"
							disabled={pendingAction !== null}
							onClick={() => {
								setConfirmingDelete(false);
								void run("delete", { type: "delete", characterId: snapshot.id, expectedRevision: snapshot.revision });
							}}
						>
							{deleteCopy.confirmLabel}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
