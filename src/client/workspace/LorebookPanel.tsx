import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Download, Plus, Search, Settings2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useSaveGuard } from "../SaveGuard";
import {
	applyLorebookCommand,
	applyLorebookAttachmentCommand,
	exportNativeLorebook,
	getLorebookAttachmentImpact,
	getLorebookAttachmentState,
	getLorebook,
	importNativeLorebook,
	importSillyTavernLorebook,
	listLorebooks,
	parseNativeLorebook,
	testLorebookMatch,
	type LoreMatchTest,
	type Lorebook,
	type LorebookCommand,
	type LoreAttachmentState,
} from "../lorebook-library";
import type { LoreEntry, LoreEntryFields } from "../../shared/contract/lorebook";
import { hasEnabledLoreSlot, type SillyTavernJsonValue } from "../../shared/contract/prompt-preset";
import { PanelHeader } from "../PanelHeader";
import { loadConversationPromptPreset } from "../conversation";
import { addPromptPresetReference, setPromptPresetBlockEnabled } from "../prompt-preset-library";

const blankEntry = (): LoreEntryFields => ({
	title: "",
	content: "",
	keywords: [],
	semanticTriggers: [],
	matchOperator: "or",
	always: false,
	requireAny: [],
	requireAll: [],
	excludeAny: [],
	excludeAll: [],
	caseSensitive: false,
	wholeWord: true,
	keywordMode: "literal",
	regexFlags: "",
	priority: 0,
	enabled: true,
});

const fieldsOf = ({ id: _id, position: _position, ...entry }: LoreEntry): LoreEntryFields => entry;
// ==[HUMAN APPROVED]== Expressions are newline-delimited in the editor. Commas are valid expression
// content (especially in quantified regular expressions), so they cannot be a
// list separator.
const splitList = (value: string): string[] => value.split(/\r?\n/).filter((part) => part.length > 0);
const joinList = (value: string[]): string => value.join("\n");
type EntryListKey = keyof Pick<LoreEntryFields, "keywords" | "semanticTriggers" | "requireAny" | "requireAll" | "excludeAny" | "excludeAll">;
const entryMatchFields = [["keywords", "Keywords"], ["semanticTriggers", "Semantic triggers"]] as const satisfies readonly (readonly [EntryListKey, string])[];
const entryConditionFields = [["requireAny", "Require any"], ["requireAll", "Require all"], ["excludeAny", "Exclude any"], ["excludeAll", "Exclude all"]] as const satisfies readonly (readonly [EntryListKey, string])[];
const parseOperator = (value: string): LoreEntryFields["matchOperator"] => value === "and" ? "and" : "or";
const sameEntry = (left: LoreEntryFields, right: LoreEntryFields): boolean => JSON.stringify(left) === JSON.stringify(right);

type LeaveIntent =
	| { type: "close" }
	| { type: "library" }
	| { type: "book"; id: number }
	| { type: "entry"; id: number | null };

type LoreAttachment = LoreAttachmentState["attachments"][number];

export function LorebookPanel({ conversationId, cast, onClose, mutationsDisabled = false }: { conversationId: number; cast: readonly { id: number; duplicateLabel: string }[]; onClose: () => void; mutationsDisabled?: boolean }) {
	const client = useQueryClient();
	const library = useQuery({ queryKey: ["lorebooks"], queryFn: ({ signal }) => listLorebooks(signal) });
	const books = library.data ?? [];
	const booksLoading = library.isPending;
	const [bookId, setBookId] = useState<number | null>(null);
	const detail = useQuery({ queryKey: ["lorebook", bookId], queryFn: ({ signal }) => bookId === null ? null : getLorebook(bookId, signal), enabled: bookId !== null, staleTime: Infinity });
	const book = detail.data ?? null;
	const setBook = (next: Lorebook | null) => {
		if (next !== null) {
			void client.cancelQueries({ queryKey: ["lorebook", next.id] });
			client.setQueryData(["lorebook", next.id], next);
		}
		setBookId(next?.id ?? null);
	};
	const attachments = useQuery({ queryKey: ["lorebook-attachments", conversationId], queryFn: ({ signal }) => getLorebookAttachmentState(conversationId, signal) });
	const attachmentState = attachments.data ?? null;
	const preset = useQuery({ queryKey: ["conversation-preset", conversationId], queryFn: ({ signal }) => loadConversationPromptPreset(conversationId, signal) });
	const selectedPreset = preset.data ?? null;
	const [entryId, setEntryId] = useState<number | null>(null);
	const [entryDraft, setEntryDraft] = useState<LoreEntryFields>(blankEntry());
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [search, setSearch] = useState("");
	const [notice, setNotice] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const [testWriting, setTestWriting] = useState("");
	const [testResult, setTestResult] = useState<LoreMatchTest | null>(null);
	const [testPending, setTestPending] = useState(false);
	const [testError, setTestError] = useState<string | null>(null);
	const [attachmentPending, setAttachmentPending] = useState(false);
	const [leaveIntent, setLeaveIntent] = useState<LeaveIntent | null>(null);
	const [bookDeleteConfirmation, setBookDeleteConfirmation] = useState<{ name: string; detail: string } | null>(null);
	const [entryDeleteConfirmation, setEntryDeleteConfirmation] = useState(false);
	const importInput = useRef<HTMLInputElement>(null);
	const nameInput = useRef<HTMLInputElement>(null);
	const selectNameOnOpen = useRef(false);
	const viewTokenRef = useRef(0);
	const importRequestRef = useRef(0);
	const matchRequestRef = useRef(0);
	const attachmentRequestRef = useRef(0);
	const presetRequestRef = useRef(0);
	const impactRequestRef = useRef(0);
	const exportRequestRef = useRef(0);
	const bookDraftVersionRef = useRef(0);
	const entryDraftVersionRef = useRef(0);
	const currentBookIdRef = useRef<number | null>(null);
	const currentConversationIdRef = useRef(conversationId);
	currentBookIdRef.current = bookId;
	currentConversationIdRef.current = conversationId;

	const invalidateView = () => {
		viewTokenRef.current += 1;
		setPending(false);
		setTestPending(false);
	};
	const isCurrentView = (token: number, bookId: number | null): boolean =>
		token === viewTokenRef.current && currentBookIdRef.current === bookId;

	useEffect(() => {
		invalidateView();
		matchRequestRef.current += 1;
		attachmentRequestRef.current += 1;
		presetRequestRef.current += 1;
		setTestResult(null);
		setTestError(null);
		setAttachmentPending(false);
	}, [conversationId]);
	useEffect(() => {
		const error = library.error ?? detail.error ?? attachments.error ?? preset.error;
		if (error) setNotice(error.message);
	}, [library.error, detail.error, attachments.error, preset.error]);

	const selectFirstEntry = (target: Lorebook) => {
		const first = target.entries[0];
		setEntryId(first?.id ?? null);
		setEntryDraft(first === undefined ? blankEntry() : fieldsOf(first));
	};

	const openBook = async (id: number) => {
		const token = ++viewTokenRef.current;
		setTestResult(null);
		setTestError(null);
		setTestPending(false);
		setPending(true);
		try {
			const loaded = await client.fetchQuery({ queryKey: ["lorebook", id], queryFn: ({ signal }) => getLorebook(id, signal) });
			if (token !== viewTokenRef.current) return;
			if (loaded === null) { setNotice("That Lorebook no longer exists."); return; }
			setBook(loaded); setName(loaded.name); setDescription(loaded.description); selectFirstEntry(loaded); entryDraftVersionRef.current += 1; setNotice(null);
		} catch { if (token === viewTokenRef.current) setNotice("The Lorebook could not be loaded."); } finally { if (token === viewTokenRef.current) setPending(false); }
	};

	const selectedEntry = book?.entries.find((entry) => entry.id === entryId);
	const bookDirty = book !== null && (name !== book.name || description !== book.description);
	const entryDirty = book !== null && !sameEntry(entryDraft, selectedEntry === undefined ? blankEntry() : fieldsOf(selectedEntry));
	const dirty = bookDirty || entryDirty;

	const performLeave = (intent: LeaveIntent) => {
		if (intent.type === "close") {
			invalidateView();
			onClose();
		} else if (intent.type === "library") {
			invalidateView();
			setBook(null);
			setEntryId(null);
		} else if (intent.type === "book") {
			void openBook(intent.id);
		} else {
			invalidateView();
			setEntryId(intent.id);
			const target = book?.entries.find((entry) => entry.id === intent.id);
			setEntryDraft(target === undefined ? blankEntry() : fieldsOf(target));
			entryDraftVersionRef.current += 1;
		}
	};

	const requestLeave = (intent: LeaveIntent) => {
		if (dirty) setLeaveIntent(intent);
		else performLeave(intent);
	};

	const discardAndLeave = () => {
		if (book !== null) {
			setName(book.name);
			setDescription(book.description);
		}
		setEntryDraft(selectedEntry === undefined ? blankEntry() : fieldsOf(selectedEntry));
		bookDraftVersionRef.current += 1;
		entryDraftVersionRef.current += 1;
		const intent = leaveIntent;
		setLeaveIntent(null);
		if (intent !== null) performLeave(intent);
	};

	const refreshLibrary = () => {
		void client.cancelQueries({ queryKey: ["lorebooks"] });
		void client.invalidateQueries({ queryKey: ["lorebooks"] });
	};
	const refreshBookCaches = (saved: Lorebook) => {
		void client.cancelQueries({ queryKey: ["lorebook", saved.id] });
		client.setQueryData(["lorebook", saved.id], saved);
		refreshLibrary();
	};

	const saveDirty = async (): Promise<boolean> => {
		if (book === null) return true;
		const hadChanges = bookDirty || entryDirty;
		const token = viewTokenRef.current;
		const initialBookId = book.id;
		const initialBookDraftVersion = bookDraftVersionRef.current;
		const initialEntryDraftVersion = entryDraftVersionRef.current;
		let current = book;
		if (bookDirty) {
			const result = await applyLorebookCommand({ type: "update-book", bookId: current.id, expectedRevision: current.revision, name, description });
			if (result.outcome !== "available" || result.value.outcome !== "applied") {
				if (!isCurrentView(token, initialBookId)) return false;
				setNotice(result.outcome === "conflict" ? "This Lorebook changed elsewhere. Your saved view was refreshed." : result.outcome === "invalid" ? result.reason : "The Lorebook operation failed.");
				if (result.outcome === "conflict") {
					setBook(result.currentBook);
				}
				return false;
			}
			refreshBookCaches(result.value.book);
			if (!isCurrentView(token, initialBookId)) return false;
			current = result.value.book;
			setBook(current);
			if (bookDraftVersionRef.current === initialBookDraftVersion) { setName(current.name); setDescription(current.description); }
		}
		if (entryDirty) {
			// ==[HUMAN APPROVED]== The book save above may have yielded to a newer entry edit. Do not
			// send the stale closure value after that edit; leave it dirty for an
			// explicit save instead.
			if (!isCurrentView(token, initialBookId) || entryDraftVersionRef.current !== initialEntryDraftVersion) return false;
			const result = await applyLorebookCommand({ type: "save-entry", bookId: current.id, entryId: entryId ?? undefined, expectedRevision: current.revision, entry: entryDraft });
			if (result.outcome !== "available" || result.value.outcome !== "applied") {
				if (!isCurrentView(token, initialBookId)) return false;
				setNotice(result.outcome === "conflict" ? "This Lorebook changed elsewhere. Your saved view was refreshed." : result.outcome === "invalid" ? result.reason : "The Lorebook operation failed.");
				if (result.outcome === "conflict") setBook(result.currentBook);
				return false;
			}
			refreshBookCaches(result.value.book);
			if (!isCurrentView(token, initialBookId)) return false;
			setBook(result.value.book);
			if (entryId === null && entryDraftVersionRef.current === initialEntryDraftVersion) {
				const saved = result.value.book.entries.at(-1);
				if (saved !== undefined) { setEntryId(saved.id); setEntryDraft(fieldsOf(saved)); }
			}
		}
		const settled = isCurrentView(token, initialBookId)
			&& bookDraftVersionRef.current === initialBookDraftVersion
			&& entryDraftVersionRef.current === initialEntryDraftVersion;
		if (settled && hadChanges) setNotice("Lorebook saved.");
		return settled;
	};

	const saveAndLeave = async () => {
		if (leaveIntent === null) return;
		setPending(true);
		try {
			if (await saveDirty()) {
				const intent = leaveIntent;
				setLeaveIntent(null);
				performLeave(intent);
			}
		} finally {
			setPending(false);
		}
	};

	const executeLorebookCommand = async (command: LorebookCommand, success?: string) => {
		const token = viewTokenRef.current;
		const commandBookId = "bookId" in command ? command.bookId : null;
		const initialBookDraftVersion = bookDraftVersionRef.current;
		const initialEntryDraftVersion = entryDraftVersionRef.current;
		const initialEntryId = entryId;
		setPending(true);
		try {
			const result = await applyLorebookCommand(command);
			if (result.outcome === "available" && result.value.outcome === "applied") refreshBookCaches(result.value.book);
			else if (result.outcome === "available" && result.value.outcome === "deleted") {
				refreshLibrary();
				client.removeQueries({ queryKey: ["lorebook", result.value.bookId] });
				void client.invalidateQueries({ queryKey: ["lorebook-attachments"] });
			}
			if (!isCurrentView(token, commandBookId)) return;
			if (result.outcome === "available" && result.value.outcome === "applied") {
				const appliedBook = result.value.book;
				setBook(appliedBook); if (bookDraftVersionRef.current === initialBookDraftVersion) { setName(appliedBook.name); setDescription(appliedBook.description); } setNotice(success ?? null);
				if (command.type === "save-entry" && command.entryId === undefined && entryDraftVersionRef.current === initialEntryDraftVersion) {
					const saved = appliedBook.entries.at(-1);
					if (saved !== undefined) { setEntryId(saved.id); setEntryDraft(fieldsOf(saved)); }
				}
				if (command.type === "set-entry-enabled" && command.entryId === initialEntryId && entryDraftVersionRef.current === initialEntryDraftVersion) setEntryDraft((draft) => ({ ...draft, enabled: command.enabled }));
			} else if (result.outcome === "available" && result.value.outcome === "deleted") {
				setBook(null); setEntryId(null); setNotice("Lorebook deleted.");
			} else if (result.outcome === "conflict") {
				const preserveBookDraft = bookDraftVersionRef.current !== initialBookDraftVersion;
				setBook(result.currentBook);
				if (!preserveBookDraft) { setName(result.currentBook.name); setDescription(result.currentBook.description); }
				setNotice("This Lorebook changed elsewhere. Your saved view was refreshed.");
			} else setNotice(result.outcome === "invalid" ? result.reason : result.outcome === "not-found" ? "That Lorebook no longer exists." : "The Lorebook operation failed.");
		} finally { if (token === viewTokenRef.current) setPending(false); }
	};

	const create = () => { selectNameOnOpen.current = true; void executeLorebookCommand({ type: "create", name: "New Lorebook", description: "" }, "Lorebook created."); };
	const filteredBooks = useMemo(() => books.filter((item) => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [books, search]);

	const saveAll = async () => {
		setPending(true);
		try { await saveDirty(); } finally { setPending(false); }
	};
	const updateEntryDraft = (next: LoreEntryFields) => { entryDraftVersionRef.current += 1; setEntryDraft(next); };
	const confirmDeleteBook = async () => {
		if (book === null) return;
		const token = viewTokenRef.current;
		const bookId = book.id;
		const request = ++impactRequestRef.current;
		try {
			const impact = await getLorebookAttachmentImpact(bookId);
			if (request !== impactRequestRef.current || !isCurrentView(token, bookId)) return;
			const attachments = impact?.attachments.map((attachment) =>
				attachment.ownerName).join("\n") ?? "";
			const detail = attachments.length === 0
				? "It has no attachments."
				: `Deleting it also removes these attachments:\n${attachments}`;
			setBookDeleteConfirmation({ name: book.name, detail });
		} catch (error) {
			if (request !== impactRequestRef.current || !isCurrentView(token, bookId)) return;
			setNotice(error instanceof Error ? error.message : "Unable to load Lorebook deletion impact.");
		}
	};
	const runMatchTest = async () => {
		if (book === null) return;
		const request = ++matchRequestRef.current;
		const token = viewTokenRef.current;
		setTestPending(true);
		setTestError(null);
		try {
			const result = await testLorebookMatch(book.id, testWriting);
			if (request === matchRequestRef.current && token === viewTokenRef.current) setTestResult(result);
		} catch (error) {
			if (request === matchRequestRef.current && token === viewTokenRef.current) setTestError(error instanceof Error ? error.message : "Lorebook matching could not be tested.");
		} finally {
			if (request === matchRequestRef.current && token === viewTokenRef.current) setTestPending(false);
		}
	};
	const updateAttachment = async (command: Parameters<typeof applyLorebookAttachmentCommand>[0]): Promise<boolean> => {
		const request = ++attachmentRequestRef.current;
		const requestConversationId = conversationId;
		const isCurrentRequest = () => request === attachmentRequestRef.current && currentConversationIdRef.current === requestConversationId;
		setAttachmentPending(true);
		try {
			const result = await applyLorebookAttachmentCommand(command);
			await client.cancelQueries({ queryKey: ["lorebook-attachments", requestConversationId] });
			if (result.outcome !== "available") {
				// ==[HUMAN APPROVED]== A conflict names a newer Conversation revision, not a state
				// snapshot: refetching the attachment read puts the fresh revision
				// in the cache before the notice shows, so an unchanged retry
				// succeeds without leaving the panel.
				if (result.outcome === "conflict") await client.invalidateQueries({ queryKey: ["lorebook-attachments", requestConversationId] });
				throw new Error(result.outcome === "invalid" ? result.reason : "Lorebook attachment settings changed elsewhere.");
			}
			await client.invalidateQueries({ queryKey: ["lorebook-attachments", requestConversationId] });
			return true;
		} catch (error) { if (isCurrentRequest()) setNotice(error instanceof Error ? error.message : "Lorebook attachment settings could not be saved."); return false; }
		finally { if (isCurrentRequest()) setAttachmentPending(false); }
	};
	const enableLoreSlot = async () => {
		if (selectedPreset === null) return;
		const request = ++presetRequestRef.current;
		const requestConversationId = conversationId;
		const isCurrentRequest = () => request === presetRequestRef.current && currentConversationIdRef.current === requestConversationId;
		setAttachmentPending(true);
		try {
			const lore = selectedPreset.slots.find((slot) => slot.reference === "lore");
			const outcome = lore === undefined
				? await addPromptPresetReference(selectedPreset.id, "lore")
				: await setPromptPresetBlockEnabled(selectedPreset.id, lore.id, true);
			if (outcome.outcome !== "available") throw new Error("The Prompt Preset rejected the Lore block change.");
			if (!isCurrentRequest()) return;
			await client.invalidateQueries({ queryKey: ["conversation-preset", requestConversationId] });
			if (!isCurrentRequest()) return;
			setNotice(lore === undefined ? "Lore block added to the selected Prompt Preset." : "Lore block enabled in the selected Prompt Preset.");
		} catch (error) {
			if (isCurrentRequest()) setNotice(error instanceof Error ? error.message : "The Lore block could not be updated.");
		} finally {
			if (isCurrentRequest()) setAttachmentPending(false);
		}
	};
	const exportBook = async () => {
		if (book === null) return;
		const token = viewTokenRef.current;
		const bookId = book.id;
		const request = ++exportRequestRef.current;
		const isCurrentRequest = () => request === exportRequestRef.current && isCurrentView(token, bookId);
		setPending(true);
		try {
			const value = await exportNativeLorebook(bookId);
			if (!isCurrentRequest()) return;
			const link = document.createElement("a");
			link.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }));
			link.download = `${value.name}.json`;
			link.click();
			URL.revokeObjectURL(link.href);
			setNotice(`Lorebook "${value.name}" exported.`);
		} catch {
			if (isCurrentRequest()) setNotice(`Lorebook "${book.name}" could not be exported. Please try again.`);
		} finally {
			if (isCurrentRequest()) setPending(false);
		}
	};
	const updateList = (key: EntryListKey, value: string) => { entryDraftVersionRef.current += 1; setEntryDraft((draft) => ({ ...draft, [key]: splitList(value) })); };
	const importFile = async (file: File) => {
		const token = viewTokenRef.current;
		const request = ++importRequestRef.current;
		setPending(true);
		try {
			const parsed: unknown = JSON.parse(await file.text());
			const native = parseNativeLorebook(JSON.stringify(parsed));
			// ==[HUMAN APPROVED]== SAFETY: JSON.parse returns the JSON value accepted by the SillyTavern import adapter.
			const result = native !== null ? await importNativeLorebook(native) : await importSillyTavernLorebook(parsed as SillyTavernJsonValue);
			if (result.outcome === "available" && result.value.outcome === "applied") refreshBookCaches(result.value.book);
			if (request !== importRequestRef.current || token !== viewTokenRef.current) return;
			if (result.outcome === "available" && result.value.outcome === "applied") {
				const imported = result.value.book;
				invalidateView();
				setBook(imported); setName(imported.name); setDescription(imported.description); selectFirstEntry(imported); bookDraftVersionRef.current += 1; entryDraftVersionRef.current += 1; setNotice(result.value.warnings.length === 0 ? "Lorebook imported." : result.value.warnings.join(" "));
			}
			else setNotice(result.outcome === "invalid" ? result.reason : "The Lorebook import failed.");
		} catch { if (request === importRequestRef.current && token === viewTokenRef.current) setNotice("The selected file is not valid JSON."); } finally { if (request === importRequestRef.current && token === viewTokenRef.current) setPending(false); }
	};

	const loreBlockMissing = selectedPreset !== null && !hasEnabledLoreSlot(selectedPreset.slots);
	useSaveGuard({ dirty, saving: pending || attachmentPending, save: saveDirty, discard: () => undefined });
	const bookName = (bookId: number) => books.find((item) => item.id === bookId)?.name ?? "Unavailable Lorebook";
	const participantName = (participantId: number) => cast.find((participant) => participant.id === participantId)?.duplicateLabel ?? "Removed Participant";
	const attachedBookIds = new Set(attachmentState?.attachments.map((attachment) => attachment.bookId));
	const setAttachmentEnabled = (state: LoreAttachmentState, attachment: LoreAttachment, enabled: boolean) => void updateAttachment(attachment.scope === "chat"
		? { type: "attach-chat", conversationId, bookId: attachment.bookId, expectedRevision: state.revision, enabled }
		: { type: "attach-participant", participantId: attachment.ownerId, bookId: attachment.bookId, expectedRevision: state.revision, scope: attachment.scope, enabled });
	const detach = (state: LoreAttachmentState, attachment: LoreAttachment) => void updateAttachment(attachment.scope === "chat"
		? { type: "detach-chat", conversationId, bookId: attachment.bookId, expectedRevision: state.revision }
		: { type: "detach-participant", participantId: attachment.ownerId, bookId: attachment.bookId, expectedRevision: state.revision, scope: attachment.scope });

	return <>
		<PanelHeader title="Lorebooks" onClose={onClose} />
		<div className="panel-body flex flex-col gap-7" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
			{attachmentState === null ? <ChatLoreLoading /> : <section className="flex flex-col gap-3" aria-labelledby="chat-lore-title">
				<div className="flex items-center justify-between gap-2">
					<h2 id="chat-lore-title" className="text-sm font-semibold whitespace-nowrap">In this chat</h2>
					<ChatLoreSettings scanDepth={attachmentState.scanDepth} allowance={attachmentState.allowance} pending={attachmentPending} onSave={(settings) => updateAttachment({ type: "save-settings", conversationId, expectedRevision: attachmentState.revision, ...settings })} />
				</div>
				{attachmentState.attachments.length === 0
					? <p className="text-sm text-muted-foreground">No Lorebooks are attached to this Chat. Attach one from the library below.</p>
					: <ul className="-mx-3 flex flex-col gap-1">{attachmentState.attachments.map((attachment) => <li className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-muted/40" key={attachment.id}>
						<button type="button" className="min-w-0 flex-1 rounded-sm text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50" onClick={() => requestLeave({ type: "book", id: attachment.bookId })}>
							<span className={`block truncate text-[0.9rem] font-semibold tracking-[-0.01em] ${attachment.enabled ? "" : "text-muted-foreground"}`}>{bookName(attachment.bookId)}</span>
							<span className="mt-0.5 block truncate text-xs text-muted-foreground">{attachmentSource(attachment, participantName)}</span>
						</button>
						<Switch checked={attachment.enabled} disabled={attachmentPending} aria-label={`Use ${bookName(attachment.bookId)} in this Chat`} onCheckedChange={(enabled) => setAttachmentEnabled(attachmentState, attachment, enabled)} />
						<Button type="button" size="icon-xs" variant="ghost" title="Detach" aria-label={`Detach ${bookName(attachment.bookId)}`} disabled={attachmentPending} onClick={() => detach(attachmentState, attachment)}><X aria-hidden="true" /></Button>
					</li>)}</ul>}
				{loreBlockMissing && attachmentState.attachments.some((attachment) => attachment.enabled) && <div className="flex items-center gap-3 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
					<p className="flex-1">The selected Prompt Preset has no enabled Lore block, so attached lore is not sent to the model.</p>
					<Button type="button" size="xs" variant="outline" disabled={attachmentPending} onClick={() => void enableLoreSlot()}>{selectedPreset.slots.some((slot) => slot.reference === "lore") ? "Enable" : "Add block"}</Button>
				</div>}
			</section>}
			<section className="flex flex-col gap-3 border-t border-border pt-6" aria-labelledby="lore-library-title">
				<div className="flex items-center justify-between gap-2">
					<h2 id="lore-library-title" className="text-sm font-semibold">Library</h2>
					<span className="flex gap-1">
						<input ref={importInput} type="file" accept="application/json,.json" className="sr-only" aria-label="Import Lorebook JSON" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} />
						<Button size="sm" variant="ghost" type="button" disabled={pending} onClick={() => importInput.current?.click()}><Upload aria-hidden="true" /> Import</Button>
						<Button type="button" size="sm" onClick={create} disabled={pending}><Plus aria-hidden="true" /> New</Button>
					</span>
				</div>
				<label className="search-field"><Search aria-hidden="true" /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Lorebooks" aria-label="Search Lorebooks" /></label>
				<ul className="-mx-3 mt-1 flex flex-col gap-1" aria-label="Lorebook library" aria-busy={booksLoading}>{booksLoading ? <LorebookLibraryLoading /> : filteredBooks.length === 0 ? <li className="px-3 py-3 text-sm text-muted-foreground">{books.length === 0 ? "No Lorebooks yet. Create one or import a JSON book." : "No Lorebooks match this search."}</li> : filteredBooks.map((item) => <li className="group relative flex items-center gap-2 rounded-xl px-3 py-3 hover:bg-muted/40 focus-within:bg-muted/40" key={item.id}>
					<button type="button" className="min-w-0 flex-1 text-left outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-3 focus-visible:after:ring-ring/50" onClick={() => void openBook(item.id)}>
						<span className="block truncate text-[0.9rem] font-semibold tracking-[-0.01em]">{item.name}</span>
						<span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.entryCount} {item.entryCount === 1 ? "entry" : "entries"}{item.description === "" ? "" : ` · ${item.description}`}</span>
					</button>
					{attachedBookIds.has(item.id)
						? <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5" aria-hidden="true" /> In chat</span>
						: attachmentState !== null && <span className="relative z-10 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"><Button type="button" size="xs" variant="ghost" disabled={attachmentPending} aria-label={`Attach ${item.name} to this Chat`} onClick={() => void updateAttachment({ type: "attach-chat", conversationId, bookId: item.id, expectedRevision: attachmentState.revision })}><Plus aria-hidden="true" /> Attach</Button></span>}
				</li>)}</ul>
			</section>
			{book === null && notice !== null && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
		</div>
		{book !== null && <Dialog open onOpenChange={(open) => { if (!open) requestLeave({ type: "library" }); }}>
			<DialogContent showCloseButton={false} className="flex max-h-[90dvh] flex-col gap-5 p-6 sm:max-w-3xl lg:max-w-5xl" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled} onOpenAutoFocus={(event) => { event.preventDefault(); if (selectNameOnOpen.current) { selectNameOnOpen.current = false; nameInput.current?.select(); } }}>
				<DialogHeader className="gap-2">
					<DialogTitle className="sr-only">Edit Lorebook</DialogTitle>
					<DialogDescription className="sr-only">Rename this Lorebook, edit its entries, and test matching against supplied writing.</DialogDescription>
					<Input ref={nameInput} className="h-9 text-base font-semibold" value={name} onChange={(event) => { bookDraftVersionRef.current += 1; setName(event.target.value); }} aria-label="Lorebook name" placeholder="Untitled Lorebook" />
					<Textarea rows={1} className="min-h-9 resize-none text-sm" value={description} onChange={(event) => { bookDraftVersionRef.current += 1; setDescription(event.target.value); }} aria-label="Lorebook description" placeholder="Add a description…" />
				</DialogHeader>
				<div className="-mx-1 flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-1">
					<div className="grid gap-6 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start">
						<div className="flex min-w-0 flex-col gap-6">
						<section className="flex min-w-0 flex-col gap-2.5"><div className="flex items-center justify-between"><h3 className="text-sm font-medium">Entries</h3><Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => requestLeave({ type: "entry", id: null })}>New entry</Button></div>{book.entries.length === 0 && <p className="text-sm text-muted-foreground">No entries yet. Fill in the new entry and save to add it.</p>}{book.entries.map((entry, index) => <div className={`flex items-center gap-2 rounded-xl border px-2 py-1.5 ${entry.id === entryId ? "border-primary bg-muted/40" : "border-border"}`} key={entry.id}><Button type="button" variant="ghost" className="min-w-0 flex-1 justify-start text-left" onClick={() => requestLeave({ type: "entry", id: entry.id })}><strong className="truncate">{entry.title || "Untitled entry"}</strong><span className="shrink-0 text-xs text-muted-foreground">{entry.enabled ? "Enabled" : "Disabled"}</span></Button><Button type="button" size="xs" variant="ghost" title="Move entry up" aria-label="Move entry up" disabled={pending || index === 0} onClick={() => void executeLorebookCommand({ type: "reorder-entry", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, toPosition: index })}>↑</Button><Button type="button" size="xs" variant="ghost" title="Move entry down" aria-label="Move entry down" disabled={pending || index === book.entries.length - 1} onClick={() => void executeLorebookCommand({ type: "reorder-entry", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, toPosition: index + 2 })}>↓</Button><Button type="button" size="xs" variant="ghost" disabled={pending} onClick={() => void executeLorebookCommand({ type: "set-entry-enabled", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, enabled: !entry.enabled })}>{entry.enabled ? "Disable" : "Enable"}</Button></div>)}</section>
						{dirty && <p className="panel-intro">Save your entry edits before testing matches.</p>}
						<MatchTester writing={testWriting} onWritingChange={(value) => { matchRequestRef.current += 1; setTestWriting(value); setTestResult(null); setTestError(null); }} result={testResult} error={testError} pending={testPending || pending || dirty} onTest={() => void runMatchTest()} />
						</div>
						{(entryId === null || selectedEntry !== undefined) && <EntryEditor entry={entryDraft} onChange={updateEntryDraft} onListChange={updateList} onDelete={entryId === null ? undefined : () => setEntryDeleteConfirmation(true)} pending={pending} />}
					</div>
					{notice !== null && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
				</div>
				<DialogFooter className="-mx-6 -mb-6 flex-wrap px-6 sm:justify-between">
					<div className="flex flex-wrap items-center gap-2">
						<Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => void confirmDeleteBook()}>Delete Lorebook</Button>
						<span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
						{attachmentState !== null && !attachmentState.attachments.some((attachment) => attachment.owner === "conversation" && attachment.bookId === book.id) && <Button type="button" size="sm" variant="outline" disabled={attachmentPending} onClick={() => void updateAttachment({ type: "attach-chat", conversationId, bookId: book.id, expectedRevision: attachmentState.revision })}>Attach to Chat</Button>}
						<Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void exportBook()}><Download aria-hidden="true" /> Export</Button>
						<Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void executeLorebookCommand({ type: "duplicate", bookId: book.id, expectedRevision: book.revision }, "Lorebook duplicated.")}>Duplicate</Button>
					</div>
					<div className="flex items-center gap-2">
						<span role="status" className="mr-2 text-sm text-muted-foreground">{pending ? "Saving…" : dirty ? "Unsaved changes" : "Saved"}</span>
						<Button type="button" size="sm" variant="ghost" onClick={() => requestLeave({ type: "library" })}>Close</Button>
						<Button type="button" size="sm" disabled={pending || !dirty} onClick={() => void saveAll()}>Save</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>}
		<UnsavedLorebookDialog open={leaveIntent !== null} pending={pending} onKeepEditing={() => setLeaveIntent(null)} onDiscard={discardAndLeave} onSave={() => void saveAndLeave()} />
		<Dialog open={bookDeleteConfirmation !== null} onOpenChange={(open) => { if (!open) setBookDeleteConfirmation(null); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader><DialogTitle>Delete {bookDeleteConfirmation?.name}?</DialogTitle><DialogDescription>{bookDeleteConfirmation?.detail}</DialogDescription></DialogHeader>
				<div className="flex flex-col gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="ghost" disabled={pending} onClick={() => setBookDeleteConfirmation(null)}>Keep Lorebook</Button><Button type="button" variant="destructive" disabled={pending} onClick={() => { const target = book; setBookDeleteConfirmation(null); if (target !== null) void executeLorebookCommand({ type: "delete", bookId: target.id, expectedRevision: target.revision }); }}>Delete Lorebook</Button></div>
			</DialogContent>
		</Dialog>
		<Dialog open={entryDeleteConfirmation} onOpenChange={(open) => { if (!open) setEntryDeleteConfirmation(false); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader><DialogTitle>Delete {entryDraft.title || "this entry"}?</DialogTitle><DialogDescription>This permanently removes the current entry from this Lorebook.</DialogDescription></DialogHeader>
				<div className="flex flex-col gap-2 sm:flex-row sm:justify-end"><Button type="button" variant="ghost" disabled={pending} onClick={() => setEntryDeleteConfirmation(false)}>Keep entry</Button><Button type="button" variant="destructive" disabled={pending} onClick={() => { const target = book; const targetEntryId = entryId; setEntryDeleteConfirmation(false); if (target !== null && targetEntryId !== null) void executeLorebookCommand({ type: "delete-entry", bookId: target.id, entryId: targetEntryId, expectedRevision: target.revision }, "Entry deleted."); }}>Delete entry</Button></div>
			</DialogContent>
		</Dialog>
	</>;
}

function attachmentSource(attachment: LoreAttachment, participantName: (id: number) => string): string {
	if (attachment.scope === "chat") return "This Chat";
	const name = participantName(attachment.ownerId);
	if (attachment.reason === "not-controlled") return `${name}, inactive until ${name} holds a Control seat`;
	if (attachment.reason === "not-in-cast") return `${name}, inactive while outside the Cast`;
	return attachment.scope === "cast" ? `${name}, while in the Cast` : `${name}, while holding a Control seat`;
}

const numberInputClass = "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

function ChatLoreSettings({ scanDepth, allowance, pending, onSave }: { scanDepth: number; allowance: number; pending: boolean; onSave: (settings: { scanDepth: number; allowance: number }) => Promise<boolean> }) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState({ scanDepth, allowance });
	const unchanged = draft.scanDepth === scanDepth && draft.allowance === allowance;
	return <Popover open={open} onOpenChange={(next) => { if (next) setDraft({ scanDepth, allowance }); setOpen(next); }}>
		<PopoverTrigger asChild><Button type="button" size="xs" variant="ghost" className="text-muted-foreground" aria-label="Chat Lore settings">{scanDepth} {scanDepth === 1 ? "message" : "messages"} · {allowance.toLocaleString()} tokens max <Settings2 aria-hidden="true" /></Button></PopoverTrigger>
		<PopoverContent align="end" className="w-64" onOpenAutoFocus={(event) => { event.preventDefault(); if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus(); }}>
			<form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void onSave(draft).then((saved) => { if (saved) setOpen(false); }); }}>
				<label className="flex flex-col gap-1 text-xs font-medium">Scan depth<span className="font-normal text-muted-foreground">Recent Messages checked for Keywords.</span><Input className={numberInputClass} type="number" min="0" step="1" value={draft.scanDepth} onChange={(event) => setDraft({ ...draft, scanDepth: Math.max(0, Math.trunc(Number(event.target.value))) })} /></label>
				<label className="flex flex-col gap-1 text-xs font-medium">Lore allowance<span className="font-normal text-muted-foreground">Estimated tokens lore may use per Generation.</span><Input className={numberInputClass} type="number" min="0" step="1" value={draft.allowance} onChange={(event) => setDraft({ ...draft, allowance: Math.max(0, Math.trunc(Number(event.target.value))) })} /></label>
				<Button type="submit" size="sm" className="self-end" disabled={pending || unchanged}>{pending ? "Saving…" : "Save"}</Button>
			</form>
		</PopoverContent>
	</Popover>;
}

function ChatLoreLoading() {
	return <section className="flex flex-col gap-2" aria-label="In this chat" aria-busy="true">
		<p className="sr-only" role="status">Loading Chat Lore settings…</p>
		<div className="flex items-center justify-between"><h2 className="text-sm font-semibold">In this chat</h2><div className="h-5 w-40 animate-pulse rounded bg-muted/50" /></div>
		{["first", "second"].map((key) => <div className="flex flex-col gap-1 py-1.5" key={key}><div className="h-4 w-2/5 animate-pulse rounded bg-muted/50" /><div className="h-3 w-1/4 animate-pulse rounded bg-muted/50" /></div>)}
	</section>;
}

function LorebookLibraryLoading() {
	return <>
		<li className="sr-only" role="status">Loading Lorebooks…</li>
		{["first", "second", "third"].map((key) => <li className="flex flex-col gap-1.5 px-3 py-3" aria-hidden="true" key={key}><div className="h-4 w-1/3 animate-pulse rounded bg-muted/50" /><div className="h-3 w-1/2 animate-pulse rounded bg-muted/50" /></li>)}
	</>;
}

function UnsavedLorebookDialog({ open, pending, onKeepEditing, onDiscard, onSave }: { open: boolean; pending: boolean; onKeepEditing: () => void; onDiscard: () => void; onSave: () => void }) {
	return <Dialog open={open} onOpenChange={(next) => { if (!next && !pending) onKeepEditing(); }}>
		<DialogContent showCloseButton={false} className="sm:max-w-sm">
			<DialogHeader>
				<DialogTitle>Unsaved Lorebook edits</DialogTitle>
				<DialogDescription>Save the current book and entry edits before leaving this view?</DialogDescription>
			</DialogHeader>
			<div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
				<Button variant="ghost" disabled={pending} onClick={onKeepEditing}>Keep editing</Button>
				<Button variant="destructive" disabled={pending} onClick={onDiscard}>Discard</Button>
				<Button disabled={pending} onClick={onSave}>Save and leave</Button>
			</div>
		</DialogContent>
	</Dialog>;
}

function MatchTester({ writing, onWritingChange, result, error, pending, onTest }: { writing: string; onWritingChange: (value: string) => void; result: LoreMatchTest | null; error: string | null; pending: boolean; onTest: () => void }) {
	return <section className="lore-match-tester flex flex-col gap-2" aria-labelledby="lore-match-tester-title">
		<div><h3 id="lore-match-tester-title" className="text-sm font-medium">Match tester</h3><p className="panel-intro">Test this Lorebook's saved entries against the writing below. Chat attachments, history, and the Prompt Preset do not affect this test.</p></div>
		<Textarea className="min-h-24" value={writing} onChange={(event) => onWritingChange(event.target.value)} placeholder="Paste the writing to test…" aria-label="Writing to test" />
		<Button type="button" size="sm" className="self-start" disabled={pending} onClick={onTest}>Test matches</Button>
		{error !== null && <p className="settings-feedback-error" role="alert">{error}</p>}
		{result !== null && <MatchTesterResult result={result} />}
	</section>;
}

function MatchTesterResult({ result }: { result: LoreMatchTest }) {
	return <div className="lore-match-result" aria-label="Lore match test result">
		<div className="lore-match-result-heading"><strong>{result.mode === "semantic" ? "Match results" : result.mode === "keyword-fallback" ? "Keyword fallback" : "No entries"}</strong><span>{result.matches.filter((entry) => entry.active).length} active entries</span></div>
		{result.fallbackReason !== undefined && <p className="settings-feedback-error">{result.fallbackReason}</p>}
		{result.matches.length === 0 ? <p className="panel-intro">This Lorebook has no saved entries.</p> : result.matches.map((entry) => <details className="lore-match-entry" key={`${entry.bookId}-${entry.entryId}`} open={entry.active}>
			<summary><span>{entry.title || "Untitled entry"}</span><strong data-active={entry.active}>{entry.active ? "Active" : entry.skipped ? "Skipped" : "Not active"}</strong></summary>
			<div className="lore-match-entry-body">
				{entry.semantic.matches.length > 0 && <div><small>Strongest Semantic Trigger</small><p>“{entry.semantic.matches.reduce((strongest, match) => match.score > strongest.score ? match : strongest).trigger}” <strong>{entry.semantic.matches.reduce((strongest, match) => match.score > strongest.score ? match : strongest).score.toFixed(3)}</strong> (threshold {entry.semantic.threshold?.toFixed(2) ?? "Unavailable"})</p></div>}
				<div><small>Primary Keywords</small><p>{conditionSummary(entry.primary)}</p></div>
				<div><small>Secondary conditions</small>{secondarySummary(entry)}</div>
				{entry.reasons.length > 0 && <p className="lore-match-reasons">{entry.reasons.join(" · ")}</p>}
			</div>
		</details>)}
	</div>;
}

function conditionSummary(condition: LoreMatchTest["matches"][number]["primary"]): string {
	const matched = condition.matchedExpressions.length === 0 ? "none" : condition.matchedExpressions.join(", ");
	const missing = condition.missingExpressions.length === 0 ? "none" : condition.missingExpressions.join(", ");
	return `Matched: ${matched} · Missing: ${missing}`;
}

function secondarySummary(entry: LoreMatchTest["matches"][number]) {
	const conditions = [
		["require any", entry.secondary.requireAny],
		["require all", entry.secondary.requireAll],
		["exclude any", entry.secondary.excludeAny],
		["exclude all", entry.secondary.excludeAll],
	] as const;
	return <div className="flex flex-col gap-1">{conditions.map(([name, condition]) => <p key={name}>{name}: {conditionSummary(condition)}</p>)}</div>;
}

function StateToggle({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
	const labelId = useId();
	return <span className="flex items-center justify-between gap-2">
		<Label htmlFor={labelId} className="text-xs text-muted-foreground">{label}</Label>
		<Switch id={labelId} checked={checked} onCheckedChange={onCheckedChange} />
	</span>;
}

function EntryEditor({ entry, onChange, onListChange, onDelete, pending }: { entry: LoreEntryFields; onChange: (entry: LoreEntryFields) => void; onListChange: (key: EntryListKey, value: string) => void; onDelete?: () => void; pending: boolean }) {
	const set = <K extends keyof LoreEntryFields>(key: K, value: LoreEntryFields[K]) => onChange({ ...entry, [key]: value });
	const hintId = useId();
	const listField = ([key, label]: readonly [EntryListKey, string]) => <div className="flex flex-col gap-1.5 text-xs text-muted-foreground" key={key}><label htmlFor={`${hintId}-${key}`}>{label}</label><Textarea id={`${hintId}-${key}`} className="min-h-16" aria-describedby={`${hintId}-${key}-hint`} value={joinList(entry[key])} onChange={(event) => onListChange(key, event.target.value)} /><p id={`${hintId}-${key}-hint`}>One expression per line. Commas are literal.</p></div>;
	const expressionGroup = (fields: readonly (readonly [EntryListKey, string])[]) => <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4">
		{fields.map(listField)}
	</div>;
	return <section className="flex min-w-0 flex-col gap-4 rounded-xl border border-border p-5">
		<h3 className="text-sm font-medium">{onDelete ? "Edit entry" : "New entry"}</h3>
		<label className="flex flex-col gap-1.5 text-xs text-muted-foreground">Title<Input value={entry.title} onChange={(event) => set("title", event.target.value)} placeholder="Editor-only" /></label>
		<label className="flex flex-col gap-1.5 text-xs text-muted-foreground">Content<Textarea className="min-h-24" value={entry.content} onChange={(event) => set("content", event.target.value)} placeholder="Literal text inserted into the prompt" /></label>
		{expressionGroup(entryMatchFields)}
		<details>
			<summary className="cursor-pointer py-1 text-xs font-medium">Secondary conditions</summary>
			<div className="pt-2">{expressionGroup(entryConditionFields)}</div>
		</details>
		<div className="grid gap-x-8 gap-y-3 py-1 sm:grid-cols-2">
			<StateToggle label="Always" checked={entry.always} onCheckedChange={(value) => set("always", value)} />
			<StateToggle label="Enabled" checked={entry.enabled} onCheckedChange={(value) => set("enabled", value)} />
			<StateToggle label="Case sensitive" checked={entry.caseSensitive} onCheckedChange={(value) => set("caseSensitive", value)} />
			<StateToggle label="Whole word" checked={entry.wholeWord} onCheckedChange={(value) => set("wholeWord", value)} />
		</div>
		<div className="flex flex-wrap items-end gap-4 text-sm">
			<div className="flex flex-col gap-1.5"><span className="text-xs text-muted-foreground">Mode</span><Select value={entry.keywordMode} onValueChange={(value) => set("keywordMode", value === "regex" ? "regex" : "literal")}><SelectTrigger aria-label="Mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="literal">Literal</SelectItem><SelectItem value="regex">Regex</SelectItem></SelectContent></Select></div>
			{entry.keywordMode === "regex" && <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">Regex flags<Input className="w-20" value={entry.regexFlags} onChange={(event) => set("regexFlags", event.target.value)} /></label>}
			<div className="flex flex-col gap-1.5"><span className="text-xs text-muted-foreground">Operator</span><Select value={entry.matchOperator} onValueChange={(value) => set("matchOperator", parseOperator(value))}><SelectTrigger aria-label="Operator"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="or">OR</SelectItem><SelectItem value="and">AND</SelectItem></SelectContent></Select></div>
			<label className="flex flex-col gap-1.5 text-xs text-muted-foreground">Priority<Input className="w-20" type="number" value={entry.priority} onChange={(event) => set("priority", Number(event.target.value))} /></label>
		</div>
		{onDelete && <Button type="button" size="sm" variant="destructive" className="self-start" disabled={pending} onClick={onDelete}>Delete entry</Button>}
	</section>;
}
