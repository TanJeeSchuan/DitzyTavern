import { useEffectEvent, useRef } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSaveGuard } from "../SaveGuard";
import type { LoreAttachmentCommand, LoreAttachmentState, LorebookCommand, LoreMatchTest } from "../lorebook-library";
import { EntryEditor, MatchTester, UnsavedLorebookDialog } from "./LorebookPanelEditors";
import { useLorebookEditor } from "./useLorebookEditor";
import type { LeaveIntent } from "./lorebook-editor-state";

/** @approved The Lorebook attachment state the editor shows and its one command. */
type LorebookEditorAttachments = {
	attachmentState: LoreAttachmentState | null;
	attachmentPending: boolean;
	updateAttachment: (command: LoreAttachmentCommand) => Promise<boolean>;
};

/** @approved The match-tester state and command the editor's writing field drives. */
type LorebookEditorTester = {
	testWriting: string;
	setTestWriting: (value: string) => void;
	testResult: LoreMatchTest | null;
	testError: string | null;
	testPending: boolean;
	runMatchTest: (bookId: number) => void;
};

export function LorebookEditorDialog({ bookId, conversationId, onOpenBook, selectName, mutationsDisabled, attachments, tester }: {
	bookId: number; conversationId: number; onOpenBook: (id: number | null, notice?: string) => void;
	selectName: boolean; mutationsDisabled: boolean; attachments: LorebookEditorAttachments;
	tester: LorebookEditorTester;
}) {
	const editor = useLorebookEditor(bookId);
	const { book, name, description, entryId, entryDraft, selectedEntry, dirty, pending, notice, leaveIntent,
		bookDeleteConfirmation, entryDeleteConfirmation, setName, setDescription, updateEntryDraft, updateList,
		setLeaveIntent, setBookDeleteConfirmation, setEntryDeleteConfirmation, confirmDeleteBook, exportBook, saveDirty } = editor;
	const { attachmentState, attachmentPending, updateAttachment } = attachments;
	const { testWriting, setTestWriting, testResult, testError, testPending, runMatchTest } = tester;
	const nameInput = useRef<HTMLInputElement>(null);
	const performLeave = (intent: LeaveIntent) => {
		if (intent.type === "library") onOpenBook(null);
		else editor.selectEntry(intent.id);
	};
	const requestLeave = (intent: LeaveIntent) => { if (dirty) setLeaveIntent(intent); else performLeave(intent); };
	const discardAndLeave = () => { editor.discard(); const intent = leaveIntent; setLeaveIntent(null); if (intent) performLeave(intent); };
	const currentLeaveIntent = useEffectEvent(() => leaveIntent);
	const saveAndLeave = async () => { if (leaveIntent && await saveDirty() && currentLeaveIntent() === leaveIntent) { setLeaveIntent(null); performLeave(leaveIntent); } };
	const saveAll = () => saveDirty();
	const execute = (command: LorebookCommand, success?: string) => editor.executeLorebookCommand(command, success, onOpenBook);
	useSaveGuard({ dirty, saving: pending || attachmentPending, save: saveDirty, discard: () => undefined });
	return <>
		{(editor.loadError ?? (!book ? notice : null)) && <p role="status" className="text-sm text-muted-foreground">{editor.loadError ?? notice}</p>}
		{book !== null && <Dialog open onOpenChange={(open) => { if (!open) requestLeave({ type: "library" }); }}>
			<DialogContent
				showCloseButton={false}
				className="flex max-h-[90dvh] flex-col gap-5 p-6 sm:max-w-3xl lg:max-w-5xl"
				inert={mutationsDisabled || undefined}
				aria-disabled={mutationsDisabled}
				onOpenAutoFocus={(event) => { event.preventDefault(); if (selectName) nameInput.current?.select(); }}
			>
				<DialogHeader className="gap-2">
					<DialogTitle className="sr-only">Edit Lorebook</DialogTitle>
					<DialogDescription className="sr-only">Rename this Lorebook, edit its entries, and test matching against supplied writing.</DialogDescription>
					<Input
						ref={nameInput}
						className="h-9 text-base font-semibold"
						value={name}
						onChange={(event) => setName(event.target.value)}
						aria-label="Lorebook name"
						placeholder="Untitled Lorebook"
					/>
					<Textarea
						rows={1}
						className="min-h-9 resize-none text-sm"
						value={description}
						onChange={(event) => setDescription(event.target.value)}
						aria-label="Lorebook description"
						placeholder="Add a description…"
					/>
				</DialogHeader>
				<div className="-mx-1 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1">
					<div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start">
						<div className="flex min-w-0 flex-col gap-6">
							<section className="flex min-w-0 flex-col gap-2.5">
								<div className="flex items-center justify-between">
									<h3 className="text-sm font-medium">Entries</h3>
									<Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => requestLeave({ type: "entry", id: null })}>New entry</Button>
								</div>
								{book.entries.length === 0 && <p className="text-sm text-muted-foreground">No entries yet. Fill in the new entry and save to add it.</p>}
								{book.entries.map((entry, index) => (
									<div
										className={`flex items-center gap-2 rounded-xl border px-2 py-1.5 ${entry.id === entryId ? "border-primary bg-muted/40" : "border-border"}`}
										key={entry.id}
									>
									<Button type="button" variant="ghost" className="min-w-0 flex-1 justify-start text-left" onClick={() => requestLeave({ type: "entry", id: entry.id })}>
										<strong className="truncate">{entry.title || "Untitled entry"}</strong>
										<span className="shrink-0 text-xs text-muted-foreground">{entry.enabled ? "Enabled" : "Disabled"}</span>
									</Button>
									<Button
										type="button"
										size="xs"
										variant="ghost"
										title="Move entry up"
										aria-label="Move entry up"
										disabled={pending || index === 0}
										onClick={() => execute({ type: "reorder-entry", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, toPosition: index })}
									>↑</Button>
									<Button
										type="button"
										size="xs"
										variant="ghost"
										title="Move entry down"
										aria-label="Move entry down"
										disabled={pending || index === book.entries.length - 1}
										onClick={() => execute({ type: "reorder-entry", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, toPosition: index + 2 })}
									>↓</Button>
									<Button
										type="button"
										size="xs"
										variant="ghost"
										disabled={pending}
										onClick={() => execute({ type: "set-entry-enabled", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, enabled: !entry.enabled })}
									>{entry.enabled ? "Disable" : "Enable"}</Button>
									</div>
								)
							)}
							</section>
							{dirty && <p className="panel-intro">Save your entry edits before testing matches.</p>}
							<MatchTester
								writing={testWriting}
								onWritingChange={setTestWriting}
								result={testResult}
								error={testError}
								pending={testPending || pending || dirty}
								onTest={() => void runMatchTest(book.id)}
							/>
						</div>
						{(entryId === null || selectedEntry !== undefined) && <EntryEditor
							entry={entryDraft}
							onChange={updateEntryDraft}
							onListChange={updateList}
							onDelete={entryId === null ? undefined : () => setEntryDeleteConfirmation(true)}
							pending={pending}
						/>}
					</div>
					{notice !== null && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
				</div>
				<DialogFooter className="-mx-6 -mb-6 flex-wrap px-6 sm:justify-between">
					<div className="flex flex-wrap items-center gap-2">
						<Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => void confirmDeleteBook()}>Delete Lorebook</Button>
						<span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
						{attachmentState !== null && !attachmentState.attachments.some((attachment) => attachment.owner === "conversation" && attachment.bookId === book.id) && <Button
							type="button"
							size="sm"
							variant="outline"
							disabled={attachmentPending}
							onClick={() => void updateAttachment({ type: "attach-chat", conversationId, bookId: book.id, expectedRevision: attachmentState.revision })}
						>Attach to Chat</Button>}
						<Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void exportBook()}><Download aria-hidden="true" /> Export</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={pending}
							onClick={() => execute({ type: "duplicate", bookId: book.id, expectedRevision: book.revision }, "Lorebook duplicated.")}
						>Duplicate</Button>
					</div>
					<div className="flex items-center gap-2">
						<span role="status" className="mr-2 text-sm text-muted-foreground">{pending ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
						<Button type="button" size="sm" variant="ghost" onClick={() => requestLeave({ type: "library" })}>Close</Button>
						<Button type="button" size="sm" disabled={pending || !dirty} onClick={() => void saveAll()}>Save</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>}
		<UnsavedLorebookDialog
			open={leaveIntent !== null}
			pending={pending}
			onKeepEditing={() => setLeaveIntent(null)}
			onDiscard={discardAndLeave}
			onSave={() => void saveAndLeave()}
		/>
		<Dialog open={bookDeleteConfirmation !== null} onOpenChange={(open) => { if (!open) setBookDeleteConfirmation(null); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Delete {bookDeleteConfirmation?.name}?</DialogTitle>
					<DialogDescription>{bookDeleteConfirmation?.detail}</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
					<Button type="button" variant="ghost" disabled={pending} onClick={() => setBookDeleteConfirmation(null)}>Keep Lorebook</Button>
					<Button
						type="button"
						variant="destructive"
						disabled={pending}
						onClick={() => {
							const target = book;
							setBookDeleteConfirmation(null);
							if (target !== null) execute({ type: "delete", bookId: target.id, expectedRevision: target.revision });
						}}
					>Delete Lorebook</Button>
				</div>
			</DialogContent>
		</Dialog>
		<Dialog open={entryDeleteConfirmation} onOpenChange={(open) => { if (!open) setEntryDeleteConfirmation(false); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Delete {entryDraft.title || "this entry"}?</DialogTitle>
					<DialogDescription>This permanently removes the current entry from this Lorebook.</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
					<Button type="button" variant="ghost" disabled={pending} onClick={() => setEntryDeleteConfirmation(false)}>Keep entry</Button>
					<Button
						type="button"
						variant="destructive"
						disabled={pending}
						onClick={() => {
							const target = book;
							const targetEntryId = entryId;
							setEntryDeleteConfirmation(false);
							if (target !== null && targetEntryId !== null) {
								execute({ type: "delete-entry", bookId: target.id, entryId: targetEntryId, expectedRevision: target.revision }, "Entry deleted.");
							}
						}}
					>Delete entry</Button>
				</div>
			</DialogContent>
		</Dialog>
	</>;
}
