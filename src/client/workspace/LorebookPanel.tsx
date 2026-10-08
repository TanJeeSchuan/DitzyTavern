import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Check, Plus, Search, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { applyLorebookCommand, importNativeLorebook, importSillyTavernLorebook, listLorebooks, parseNativeLorebook, type LoreAttachmentState, type Lorebook } from "../lorebook-library";
import type { SillyTavernJsonValue } from "../../shared/contract/prompt-preset";
import { PanelHeader } from "../PanelHeader";
import { attachmentSource, ChatLoreLoading, ChatLoreSettings, LorebookLibraryLoading, type LoreAttachment } from "./LorebookPanelEditors";
import { useLoreMatchTester } from "./useLoreMatchTester";
import { useLorebookAttachments } from "./useLorebookAttachments";
import { LorebookEditorDialog } from "./LorebookEditorDialog";

interface LorebookPanelProps {
	conversationId: number;
	cast: readonly { id: number; duplicateLabel: string }[];
	onClose: () => void;
	mutationsDisabled?: boolean;
}
export function LorebookPanel(props: LorebookPanelProps) {
	return <LorebookPanelBody key={props.conversationId} {...props} />;
}
function LorebookPanelBody({ conversationId, cast, onClose, mutationsDisabled = false }: LorebookPanelProps) {
	const client = useQueryClient();
	const library = useQuery({ queryKey: ["lorebooks"], queryFn: ({ signal }) => listLorebooks(signal) });
	const books = library.data ?? [];
	const booksLoading = library.isPending;
	const [bookId, setBookId] = useState<number | null>(null);
	const [search, setSearch] = useState("");
	const [notice, setNotice] = useState<string | null>(null);
	const [selectName, setSelectName] = useState(false);
	const importInput = useRef<HTMLInputElement>(null);
	const attachmentController = useLorebookAttachments(conversationId);
	const tester = useLoreMatchTester();
	const { attachmentState, selectedPreset, loreBlockMissing, attachmentPending, updateAttachment, enableLoreSlot } = attachmentController;
	const cacheBook = async (book: Lorebook) => {
		await client.cancelQueries({ queryKey: ["lorebook", book.id] });
		client.setQueryData(["lorebook", book.id], book);
		void client.invalidateQueries({ queryKey: ["lorebooks"] });
	};
	const creation = useMutation({
		mutationFn: () => applyLorebookCommand({ type: "create", name: "New Lorebook", description: "" }),
		onSuccess: async (result) => { if (result.outcome === "available" && result.value.outcome === "applied") await cacheBook(result.value.book); },
	});
	const importing = useMutation({
		mutationFn: async (file: File) => {
			const parsed: SillyTavernJsonValue = JSON.parse(await file.text());
			const native = parseNativeLorebook(JSON.stringify(parsed));
			return native !== null ? importNativeLorebook(native) : importSillyTavernLorebook(parsed);
		},
		onSuccess: async (result) => { if (result.outcome === "available" && result.value.outcome === "applied") await cacheBook(result.value.book); },
	});
	const openBook = (id: number | null, notice: string | null = null) => { creation.reset(); importing.reset(); tester.reset(); setSelectName(false); setBookId(id); setNotice(notice); };
	const create = () => creation.mutate(undefined, {
		onSuccess: (result) => {
			if (result.outcome === "available" && result.value.outcome === "applied") { tester.reset(); setBookId(result.value.book.id); setSelectName(true); setNotice("Lorebook created."); }
			else setNotice(result.outcome === "invalid" ? result.reason : "The Lorebook operation failed.");
		},
	});
	const importFile = (file: File) => importing.mutate(file, {
		onSuccess: (result) => {
			if (result.outcome === "available" && result.value.outcome === "applied") {
				tester.reset(); setBookId(result.value.book.id); setSelectName(false);
				setNotice(result.value.warnings.length === 0 ? "Lorebook imported." : result.value.warnings.join(" "));
			} else setNotice(result.outcome === "invalid" ? result.reason : "The Lorebook import failed.");
		},
		onError: () => setNotice("The selected file is not valid JSON."),
	});
	const pending = creation.isPending || importing.isPending;
	const filteredBooks = books.filter((item) => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
	const bookName = (id: number) => books.find((item) => item.id === id)?.name ?? "Unavailable Lorebook";
	const participantName = (id: number) => cast.find((participant) => participant.id === id)?.duplicateLabel ?? "Removed Participant";
	const attachedBookIds = new Set(attachmentState?.attachments.map((attachment) => attachment.bookId));
	const setAttachmentEnabled = (state: LoreAttachmentState, attachment: LoreAttachment, enabled: boolean) => void updateAttachment(
		attachment.scope === "chat"
			? { type: "attach-chat", conversationId, bookId: attachment.bookId, expectedRevision: state.revision, enabled }
			: { type: "attach-participant", participantId: attachment.ownerId, bookId: attachment.bookId, expectedRevision: state.revision, scope: attachment.scope, enabled },
	);
	const detach = (state: LoreAttachmentState, attachment: LoreAttachment) => void updateAttachment(
		attachment.scope === "chat"
			? { type: "detach-chat", conversationId, bookId: attachment.bookId, expectedRevision: state.revision }
			: { type: "detach-participant", participantId: attachment.ownerId, bookId: attachment.bookId, expectedRevision: state.revision, scope: attachment.scope },
	);
	return <>
		<PanelHeader title="Lorebooks" onClose={onClose} />
		<div className="panel-body flex flex-col gap-7" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
			{attachmentState === null
				? <ChatLoreLoading />
				: <section className="flex flex-col gap-3" aria-labelledby="chat-lore-title">
					<div className="flex items-center justify-between gap-2">
						<h2 id="chat-lore-title" className="text-sm font-semibold whitespace-nowrap">In this chat</h2>
						<ChatLoreSettings
							scanDepth={attachmentState.scanDepth}
							allowance={attachmentState.allowance}
							pending={attachmentPending}
							onSave={(settings) => updateAttachment({ type: "save-settings", conversationId, expectedRevision: attachmentState.revision, ...settings })}
						/>
					</div>
					{attachmentState.attachments.length === 0
						? <p className="text-sm text-muted-foreground">No Lorebooks are attached to this Chat. Attach one from the library below.</p>
						: <ul className="-mx-3 flex flex-col gap-1">
							{attachmentState.attachments.map((attachment) => <li className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-muted/40" key={attachment.id}>
								<button
									type="button"
									className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
									onClick={() => openBook(attachment.bookId)}
								>
									<span className={`block truncate text-[0.9rem] font-semibold tracking-[-0.01em] ${attachment.enabled ? "" : "text-muted-foreground"}`}>{bookName(attachment.bookId)}</span>
									<span className="mt-0.5 block truncate text-xs text-muted-foreground">{attachmentSource(attachment, participantName)}</span>
								</button>
								<Switch
									checked={attachment.enabled}
									disabled={attachmentPending}
									aria-label={`Use ${bookName(attachment.bookId)} in this Chat`}
									onCheckedChange={(enabled) => setAttachmentEnabled(attachmentState, attachment, enabled)}
								/>
								<Button
									type="button"
									size="icon-xs"
									variant="ghost"
									title="Detach"
									aria-label={`Detach ${bookName(attachment.bookId)}`}
									disabled={attachmentPending}
									onClick={() => detach(attachmentState, attachment)}
								><X aria-hidden="true" /></Button>
							</li>)}
						</ul>}
					{selectedPreset !== null && loreBlockMissing && attachmentState.attachments.some((attachment) => attachment.enabled) && (
						<div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
						<p className="flex-1">The selected Prompt Preset has no enabled Lore block, so attached lore is not sent to the model.</p>
						<Button type="button" size="xs" variant="outline" disabled={attachmentPending} onClick={() => void enableLoreSlot()}>
							{selectedPreset.slots.some((slot) => slot.reference === "lore") ? "Enable" : "Add block"}
						</Button>
						</div>
					)}
				</section>}
			<section className="flex flex-col gap-3 border-t border-border pt-6" aria-labelledby="lore-library-title">
				<div className="flex items-center justify-between gap-2">
					<h2 id="lore-library-title" className="text-sm font-semibold">Library</h2>
					<span className="flex gap-1">
						<input
							ref={importInput}
							type="file"
							accept="application/json,.json"
							className="sr-only"
							aria-label="Import Lorebook JSON"
							onChange={(event) => {
								const file = event.target.files?.[0];
								event.target.value = "";
								if (file) void importFile(file);
							}}
						/>
						<Button size="sm" variant="ghost" type="button" disabled={pending} onClick={() => importInput.current?.click()}><Upload aria-hidden="true" /> Import</Button>
						<Button type="button" size="sm" onClick={create} disabled={pending}><Plus aria-hidden="true" /> New</Button>
					</span>
				</div>
				<label className="search-field">
					<Search aria-hidden="true" />
					<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Lorebooks" aria-label="Search Lorebooks" />
				</label>
				<ul className="-mx-3 mt-1 flex flex-col gap-1" aria-label="Lorebook library" aria-busy={booksLoading}>
					{booksLoading
						? <LorebookLibraryLoading />
						: filteredBooks.length === 0
							? <li className="px-3 py-3 text-sm text-muted-foreground">
								{books.length === 0 ? "No Lorebooks yet. Create one or import a JSON book." : "No Lorebooks match this search."}
							</li>
							: filteredBooks.map((item) => <li className="group relative flex items-center gap-2 rounded-xl px-3 py-3 hover:bg-muted/40 focus-within:bg-muted/40" key={item.id}>
								<button
									type="button"
									className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
									onClick={() => void openBook(item.id)}
								>
									<span className="block truncate text-[0.9rem] font-semibold tracking-[-0.01em]">{item.name}</span>
									<span className="mt-0.5 block truncate text-xs text-muted-foreground">
										{item.entryCount} {item.entryCount === 1 ? "entry" : "entries"}{item.description === "" ? "" : ` · ${item.description}`}
									</span>
								</button>
								{attachedBookIds.has(item.id)
									? <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5" aria-hidden="true" /> In chat</span>
									: attachmentState !== null && <span className="relative z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
										<Button
											type="button"
											size="xs"
											variant="ghost"
											disabled={attachmentPending}
											aria-label={`Attach ${item.name} to this Chat`}
											onClick={() => void updateAttachment({ type: "attach-chat", conversationId, bookId: item.id, expectedRevision: attachmentState.revision })}
										><Plus aria-hidden="true" /> Attach</Button>
									</span>}
							</li>)}
				</ul>
			</section>
			{(notice ?? attachmentController.notice ?? library.error?.message) && <p role="status" className="text-sm text-muted-foreground">
				{notice ?? attachmentController.notice ?? library.error?.message}
			</p>}
		</div>
		{bookId !== null && <LorebookEditorDialog key={bookId} bookId={bookId} conversationId={conversationId}
			onOpenBook={openBook} selectName={selectName} mutationsDisabled={mutationsDisabled} attachments={attachmentController} tester={tester} />}
	</>;
}
