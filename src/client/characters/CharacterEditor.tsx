import { MoreHorizontal, Pin, Plus, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
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
import { LIBRARY_UNREACHABLE_NOTICE } from "../lib/notices";
import { useAsyncEffect } from "../lib/use-async";
import { LoreAttachmentEditor } from "../lorebook/LoreAttachmentEditor";
import { useSaveGuard } from "../SaveGuard";
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
	const [draft, setDraft] = useState<ParticipantDefinition | null>(null);
	const [conflict, setConflict] = useState<CharacterSnapshot | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [pendingAction, setPendingAction] = useState<"save" | "pin" | "delete" | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const draftRef = useRef(draft);
	draftRef.current = draft;

	useAsyncEffect((isCancelled) => {
		void getCharacter(characterId).then((loaded) => {
			if (isCancelled()) return;
			if (loaded === null) return onClosed("That Character is no longer in the Library.");
			setSnapshot(loaded);
			setDraft(definitionOf(loaded));
		}, () => { if (!isCancelled()) onClosed(LIBRARY_UNREACHABLE_NOTICE); });
	}, [characterId]);

	const run = useCallback(async (action: "save" | "pin" | "delete", command: CharacterCommand) => {
		const submitted = draftRef.current;
		setPendingAction(action);
		try {
			const outcome = await applyCommand(command);
			switch (outcome.outcome) {
				case "available": {
					const applied = outcome.value;
					if ("result" in applied) {
						onChanged();
						onClosed(deletionResultNotice(applied.result));
						return false;
					}
					setSnapshot(applied.character);
					// @approved
					//  Only a save adopts the saved Definition, and only when nothing was typed meanwhile.
					if (command.type === "update-definition") setDraft((current) => current === submitted ? definitionOf(applied.character) : current);
					setConflict(null);
					setNotice(null);
					onChanged();
					return draftRef.current === submitted;
				}
				case "conflict":
					setConflict(outcome.currentCharacter);
					return false;
				case "not-found":
					onChanged();
					onClosed("That Character is no longer in the Library.");
					return false;
				case "invalid":
					setNotice(outcome.reason);
					return false;
				default:
					setNotice(LIBRARY_UNREACHABLE_NOTICE);
					return false;
			}
		} catch (cause) {
			setNotice(cause instanceof Error ? cause.message : LIBRARY_UNREACHABLE_NOTICE);
			return false;
		} finally {
			setPendingAction(null);
		}
	}, [onChanged, onClosed, snapshot]);

	const dirty = snapshot !== null && draft !== null && !sameDefinition(draft, definitionOf(snapshot));
	const save = async () =>
		snapshot !== null &&
		draft !== null &&
		dirty &&
		run("save", {
			type: "update-definition",
			characterId: snapshot.id,
			expectedRevision: snapshot.revision,
			definition: submittableDefinition(draft),
		});
	useSaveGuard({ dirty, saving: pendingAction === "save", save, discard: () => undefined });

	if (snapshot === null || draft === null) return <p className="panel-body text-sm text-muted-foreground" role="status">Loading the Character…</p>;
	const deleteCopy = deletionConfirmationCopy(snapshot.name, snapshot.deletionImpact);

	return (
		<>
			<DefinitionEditor
				draft={draft}
				onDraftChange={setDraft}
				subtitle={`Library Character · ${usedCountLabel(snapshot.deletionImpact.provenanceReferenceCount)}`}
				dirty={dirty}
				saving={pendingAction === "save"}
				error={notice}
				valid={conflict === null}
				autoSelectName={autoSelectName}
				onSave={() => void save()}
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
				banner={conflict !== null && (
					<div className="conflict-banner" role="alert">
						<p>This Character changed elsewhere after you opened it. Your edits were not saved and are still here.</p>
						<div>
							<Button type="button" size="sm" onClick={() => { setSnapshot(conflict); setConflict(null); }}>Keep my edits</Button>
							<Button type="button" size="sm" variant="outline" onClick={() => { setSnapshot(conflict); setDraft(definitionOf(conflict)); setConflict(null); }}>Load saved version</Button>
						</div>
					</div>
				)}
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
