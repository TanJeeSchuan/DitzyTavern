import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Download, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
import type { SillyTavernJsonValue } from "../../shared/contract/prompt-preset";
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
	semanticThreshold: null,
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

export function LorebookPanel({ conversationId, onClose, mutationsDisabled = false }: { conversationId: number; onClose: () => void; mutationsDisabled?: boolean }) {
	const [books, setBooks] = useState<Awaited<ReturnType<typeof listLorebooks>>>([]);
	const [booksLoading, setBooksLoading] = useState(true);
	const [book, setBook] = useState<Lorebook | null>(null);
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
	const [attachmentState, setAttachmentState] = useState<LoreAttachmentState | null>(null);
	const [attachmentPending, setAttachmentPending] = useState(false);
	const [selectedPreset, setSelectedPreset] = useState<Awaited<ReturnType<typeof loadConversationPromptPreset>>>(null);
	const [leaveIntent, setLeaveIntent] = useState<LeaveIntent | null>(null);
	const [bookDeleteConfirmation, setBookDeleteConfirmation] = useState<{ name: string; detail: string } | null>(null);
	const [entryDeleteConfirmation, setEntryDeleteConfirmation] = useState(false);
	const importInput = useRef<HTMLInputElement>(null);
	const viewTokenRef = useRef(0);
	const libraryRequestRef = useRef(0);
	const matchRequestRef = useRef(0);
	const attachmentRequestRef = useRef(0);
	const presetRequestRef = useRef(0);
	const impactRequestRef = useRef(0);
	const exportRequestRef = useRef(0);
	const bookDraftVersionRef = useRef(0);
	const entryDraftVersionRef = useRef(0);
	const currentBookIdRef = useRef<number | null>(null);
	const currentConversationIdRef = useRef(conversationId);
	currentBookIdRef.current = book?.id ?? null;
	currentConversationIdRef.current = conversationId;

	const invalidateView = () => {
		viewTokenRef.current += 1;
		setPending(false);
		setTestPending(false);
	};
	const isCurrentView = (token: number, bookId: number | null): boolean =>
		token === viewTokenRef.current && currentBookIdRef.current === bookId;

	const refresh = useCallback(async () => {
		const request = ++libraryRequestRef.current;
		setBooksLoading(true);
		try {
			const loaded = await listLorebooks();
			if (request !== libraryRequestRef.current) return;
			setBooks(loaded);
			if (book !== null) {
				const current = await getLorebook(book.id);
				if (request === libraryRequestRef.current && current !== null && currentBookIdRef.current === book.id) {
					setBook(current);
					setName(current.name);
					setDescription(current.description);
				}
			}
		} catch { if (request === libraryRequestRef.current) setNotice("The Lorebook library could not be loaded."); }
		finally { if (request === libraryRequestRef.current) setBooksLoading(false); }
	}, [book]);

	// ==[HUMAN APPROVED]== The first load is intentionally initial-only; mutations update local state.
	useEffect(() => { void refresh(); }, []);
	useEffect(() => {
		invalidateView();
		matchRequestRef.current += 1;
		setTestResult(null);
		setTestError(null);
		const attachmentRequest = ++attachmentRequestRef.current;
		const presetRequest = ++presetRequestRef.current;
		setAttachmentPending(false);
		void getLorebookAttachmentState(conversationId).then((state) => {
			if (attachmentRequest === attachmentRequestRef.current && currentConversationIdRef.current === conversationId) setAttachmentState(state);
		}).catch(() => { if (attachmentRequest === attachmentRequestRef.current && currentConversationIdRef.current === conversationId) setNotice("Lorebook attachment settings could not be loaded."); });
		void loadConversationPromptPreset(conversationId).then((preset) => {
			if (presetRequest === presetRequestRef.current && currentConversationIdRef.current === conversationId) setSelectedPreset(preset);
		}).catch(() => { if (presetRequest === presetRequestRef.current && currentConversationIdRef.current === conversationId) setNotice("The selected Prompt Preset could not be loaded."); });
	}, [conversationId]);

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
			const loaded = await getLorebook(id);
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
			if (result.status !== "applied") {
				if (!isCurrentView(token, initialBookId)) return false;
				setNotice(result.status === "conflict" ? "This Lorebook changed elsewhere. Your saved view was refreshed." : result.status === "invalid" ? result.reason : "The Lorebook operation failed.");
				if (result.status === "conflict") {
					setBook(result.currentBook);
				}
				return false;
			}
			if (!isCurrentView(token, initialBookId)) return false;
			current = result.book;
			setBook(current);
			if (bookDraftVersionRef.current === initialBookDraftVersion) { setName(current.name); setDescription(current.description); }
		}
		if (entryDirty) {
			// ==[HUMAN APPROVED]== The book save above may have yielded to a newer entry edit. Do not
			// send the stale closure value after that edit; leave it dirty for an
			// explicit save instead.
			if (!isCurrentView(token, initialBookId) || entryDraftVersionRef.current !== initialEntryDraftVersion) return false;
			const result = await applyLorebookCommand({ type: "save-entry", bookId: current.id, entryId: entryId ?? undefined, expectedRevision: current.revision, entry: entryDraft });
			if (result.status !== "applied") {
				if (!isCurrentView(token, initialBookId)) return false;
				setNotice(result.status === "conflict" ? "This Lorebook changed elsewhere. Your saved view was refreshed." : result.status === "invalid" ? result.reason : "The Lorebook operation failed.");
				if (result.status === "conflict") setBook(result.currentBook);
				return false;
			}
			if (!isCurrentView(token, initialBookId)) return false;
			setBook(result.book);
			if (entryId === null && entryDraftVersionRef.current === initialEntryDraftVersion) {
				const saved = result.book.entries.at(-1);
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
			if (result.status === "applied") {
				setBooks((items) => {
					const summary = { id: result.book.id, name: result.book.name, description: result.book.description, revision: result.book.revision, entryCount: result.book.entries.length };
					return items.some((item) => item.id === result.book.id)
						? items.map((item) => item.id === result.book.id ? summary : item)
						: [...items, summary];
				});
			} else if (result.status === "deleted") {
				setBooks((items) => items.filter((item) => item.id !== result.bookId));
			}
			if (!isCurrentView(token, commandBookId)) return;
			if (result.status === "applied") {
				setBook(result.book); if (bookDraftVersionRef.current === initialBookDraftVersion) { setName(result.book.name); setDescription(result.book.description); } setNotice(success ?? null);
				if (command.type === "save-entry" && command.entryId === undefined && entryDraftVersionRef.current === initialEntryDraftVersion) {
					const saved = result.book.entries.at(-1);
					if (saved !== undefined) { setEntryId(saved.id); setEntryDraft(fieldsOf(saved)); }
				}
				if (command.type === "set-entry-enabled" && command.entryId === initialEntryId && entryDraftVersionRef.current === initialEntryDraftVersion) setEntryDraft((draft) => ({ ...draft, enabled: command.enabled }));
			} else if (result.status === "deleted") {
				setBook(null); setEntryId(null); setNotice("Lorebook deleted.");
			} else if (result.status === "conflict") {
				const preserveBookDraft = bookDraftVersionRef.current !== initialBookDraftVersion;
				setBook(result.currentBook);
				if (!preserveBookDraft) { setName(result.currentBook.name); setDescription(result.currentBook.description); }
				setNotice("This Lorebook changed elsewhere. Your saved view was refreshed.");
			} else setNotice(result.status === "invalid" ? result.reason : result.status === "not-found" ? "That Lorebook no longer exists." : "The Lorebook operation failed.");
		} finally { if (token === viewTokenRef.current) setPending(false); }
	};

	const create = () => void executeLorebookCommand({ type: "create", name: "New Lorebook", description: "" }, "Lorebook created.");
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
				`${attachment.owner} ${attachment.ownerId} (${attachment.scope})`).join("\n") ?? "";
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
	const updateAttachment = async (command: Parameters<typeof applyLorebookAttachmentCommand>[0]) => {
		const request = ++attachmentRequestRef.current;
		const requestConversationId = conversationId;
		setAttachmentPending(true);
		try {
			const result = await applyLorebookAttachmentCommand(command);
			if (request !== attachmentRequestRef.current || currentConversationIdRef.current !== requestConversationId) return;
			if (result.status !== "applied") {
				if (result.status === "conflict" && "conversationId" in result.currentState) setAttachmentState(result.currentState);
				throw new Error(result.status === "invalid" ? result.reason : "Lorebook attachment settings changed elsewhere.");
			}
			const state = await getLorebookAttachmentState(requestConversationId);
			if (request === attachmentRequestRef.current && currentConversationIdRef.current === requestConversationId) setAttachmentState(state);
		} catch { if (request === attachmentRequestRef.current && currentConversationIdRef.current === requestConversationId) setNotice("Lorebook attachment settings could not be saved."); }
		finally {
			if (request === attachmentRequestRef.current && currentConversationIdRef.current === requestConversationId) setAttachmentPending(false);
		}
	};
	const saveChatSettings = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (attachmentState === null) return;
		void updateAttachment({ type: "save-settings", conversationId, expectedRevision: attachmentState.revision, scanDepth: attachmentState.scanDepth, allowance: attachmentState.allowance });
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
			if (outcome.status !== "applied") throw new Error("The Prompt Preset rejected the Lore block change.");
			if (!isCurrentRequest()) return;
			const preset = await loadConversationPromptPreset(requestConversationId);
			if (!isCurrentRequest()) return;
			setSelectedPreset(preset);
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
		const request = ++libraryRequestRef.current;
		setPending(true);
		try {
			const parsed: unknown = JSON.parse(await file.text());
			const native = parseNativeLorebook(JSON.stringify(parsed));
			// ==[HUMAN APPROVED]== SAFETY: JSON.parse returns the JSON value accepted by the SillyTavern import adapter.
			const result = native !== null ? await importNativeLorebook(native) : await importSillyTavernLorebook(parsed as SillyTavernJsonValue);
			if (result.status === "applied") setBooks((items) => [...items, { id: result.book.id, name: result.book.name, description: result.book.description, revision: result.book.revision, entryCount: result.book.entries.length }]);
			if (request !== libraryRequestRef.current || token !== viewTokenRef.current) return;
			if (result.status === "applied") {
				invalidateView();
				setBook(result.book); setName(result.book.name); setDescription(result.book.description); selectFirstEntry(result.book); bookDraftVersionRef.current += 1; entryDraftVersionRef.current += 1; setNotice(result.warnings.length === 0 ? "Lorebook imported." : result.warnings.join(" "));
			}
			else setNotice(result.status === "invalid" ? result.reason : "The Lorebook import failed.");
		} catch { if (request === libraryRequestRef.current && token === viewTokenRef.current) setNotice("The selected file is not valid JSON."); } finally { if (request === libraryRequestRef.current && token === viewTokenRef.current) setPending(false); }
	};

	const loreBlockNotice = selectedPreset !== null && !selectedPreset.slots.some((slot) => slot.reference === "lore" && slot.enabled) && <div className="rounded-md border border-border p-2 text-sm">
		<p>The selected Prompt Preset needs an enabled Lore block to use attached Lorebooks during Generation.</p>
		<Button type="button" size="sm" variant="outline" disabled={attachmentPending} onClick={() => void enableLoreSlot()}>{selectedPreset.slots.some((slot) => slot.reference === "lore") ? "Enable Lore block" : "Add Lore block"}</Button>
	</div>;

	return <>
		<PanelHeader title="Lorebooks" onClose={() => requestLeave({ type: "close" })} />
		<div className="panel-body flex flex-col gap-4" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
			{attachmentState === null ? <ChatLoreSettingsLoading /> : <section className="flex flex-col gap-2 rounded-lg border border-border p-3" aria-label="Chat Lore settings">
				<h2 className="text-sm font-medium">Chat Lore settings</h2>
				<form className="flex flex-wrap items-end gap-2" onSubmit={saveChatSettings}>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">Scan Messages<Input className="w-28" type="number" min="0" step="1" value={attachmentState.scanDepth} disabled={attachmentPending} onChange={(event) => setAttachmentState({ ...attachmentState, scanDepth: Math.max(0, Number(event.target.value)) })} /></label>
					<label className="flex flex-col gap-1 text-xs text-muted-foreground">Lore allowance<Input className="w-28" type="number" min="0" step="1" value={attachmentState.allowance} disabled={attachmentPending} onChange={(event) => setAttachmentState({ ...attachmentState, allowance: Math.max(0, Number(event.target.value)) })} /></label>
					<Button type="submit" size="sm" disabled={attachmentPending}>Save settings</Button>
				</form>
				<div className="flex flex-col gap-1 text-sm"><strong>Attached Chat books</strong>{attachmentState.attachments.filter((attachment) => attachment.owner === "conversation").length === 0 ? <p className="panel-intro">No Lorebooks are attached to this Chat.</p> : attachmentState.attachments.filter((attachment) => attachment.owner === "conversation").map((attachment) => <div className="flex items-center justify-between gap-2" key={attachment.id}><span>Book {attachment.bookId} <small>{attachment.eligible ? "Eligible" : attachment.reason}</small></span><span className="flex gap-1"><Button type="button" size="xs" variant="ghost" disabled={attachmentPending} onClick={() => void updateAttachment({ type: "attach-chat", conversationId, bookId: attachment.bookId, expectedRevision: attachmentState.revision, enabled: !attachment.enabled })}>{attachment.enabled ? "Disable" : "Enable"}</Button><Button type="button" size="xs" variant="ghost" disabled={attachmentPending} onClick={() => void updateAttachment({ type: "detach-chat", conversationId, bookId: attachment.bookId, expectedRevision: attachmentState.revision })}>Detach</Button></span></div>)}</div>
				{attachmentState.attachments.some((attachment) => attachment.enabled) && loreBlockNotice}
			</section>}
			<div className="flex items-center gap-2">
				<input ref={importInput} type="file" accept="application/json,.json" className="sr-only" aria-label="Import Lorebook JSON" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} />
				<Button size="sm" variant="outline" type="button" disabled={pending} onClick={() => importInput.current?.click()}><Upload aria-hidden="true" /> Import</Button>
				<Button type="button" size="sm" onClick={create} disabled={pending}><Plus aria-hidden="true" /> New</Button>
			</div>
			<Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Lorebooks" aria-label="Search Lorebooks" />
			<div className="flex flex-col gap-2" aria-label="Lorebook library" aria-busy={booksLoading}>{booksLoading ? <LorebookLibraryLoading /> : filteredBooks.length === 0 ? <p className="panel-intro">No Lorebooks yet. Create one or import a JSON book.</p> : filteredBooks.map((item) => <Button type="button" variant="outline" key={item.id} className="h-auto justify-start p-3 text-left" onClick={() => void openBook(item.id)}><span><strong>{item.name}</strong><span className="block text-xs text-muted-foreground">{item.entryCount} {item.entryCount === 1 ? "entry" : "entries"}</span></span></Button>)}</div>
			{book === null && notice !== null && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
		</div>
		{book !== null && <Dialog open onOpenChange={(open) => { if (!open) requestLeave({ type: "library" }); }}>
			<DialogContent showCloseButton={false} className="flex max-h-[90dvh] flex-col gap-4 sm:max-w-3xl lg:max-w-5xl" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled} onOpenAutoFocus={(event) => event.preventDefault()}>
				<DialogHeader className="gap-1">
					<DialogTitle className="sr-only">Edit Lorebook</DialogTitle>
					<DialogDescription className="sr-only">Rename this Lorebook, edit its entries, and test matching against supplied writing.</DialogDescription>
					<Input className="h-9 text-base font-semibold" value={name} onChange={(event) => { bookDraftVersionRef.current += 1; setName(event.target.value); }} aria-label="Lorebook name" placeholder="Untitled Lorebook" />
					<Textarea rows={1} className="min-h-9 resize-none text-sm" value={description} onChange={(event) => { bookDraftVersionRef.current += 1; setDescription(event.target.value); }} aria-label="Lorebook description" placeholder="Add a description…" />
				</DialogHeader>
				<div className="-mx-1 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-1">
					<div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start">
						<div className="flex min-w-0 flex-col gap-4">
						<section className="flex min-w-0 flex-col gap-2"><div className="flex items-center justify-between"><h3 className="text-sm font-medium">Entries</h3><Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => requestLeave({ type: "entry", id: null })}>New entry</Button></div>{book.entries.map((entry, index) => <div className={`flex items-center gap-2 rounded-lg border p-2 ${entry.id === entryId ? "border-primary bg-muted/40" : "border-border"}`} key={entry.id}><Button type="button" variant="ghost" className="min-w-0 flex-1 justify-start text-left" onClick={() => requestLeave({ type: "entry", id: entry.id })}><strong className="truncate">{entry.title || "Untitled entry"}</strong><span className="shrink-0 text-xs text-muted-foreground">{entry.enabled ? "Enabled" : "Disabled"}</span></Button><Button type="button" size="xs" variant="ghost" title="Move entry up" aria-label="Move entry up" disabled={pending || index === 0} onClick={() => void executeLorebookCommand({ type: "reorder-entry", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, toPosition: index })}>↑</Button><Button type="button" size="xs" variant="ghost" title="Move entry down" aria-label="Move entry down" disabled={pending || index === book.entries.length - 1} onClick={() => void executeLorebookCommand({ type: "reorder-entry", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, toPosition: index + 2 })}>↓</Button><Button type="button" size="xs" variant="ghost" disabled={pending} onClick={() => void executeLorebookCommand({ type: "set-entry-enabled", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, enabled: !entry.enabled })}>{entry.enabled ? "Disable" : "Enable"}</Button></div>)}</section>
						{dirty && <p className="panel-intro">Save your entry edits before testing matches.</p>}
						<MatchTester writing={testWriting} onWritingChange={(value) => { matchRequestRef.current += 1; setTestWriting(value); setTestResult(null); setTestError(null); }} result={testResult} error={testError} pending={testPending || pending || dirty} onTest={() => void runMatchTest()} />
						</div>
						{(entryId === null || selectedEntry !== undefined) && <EntryEditor entry={entryDraft} onChange={updateEntryDraft} onListChange={updateList} onDelete={entryId === null ? undefined : () => setEntryDeleteConfirmation(true)} pending={pending} />}
					</div>
					{notice !== null && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
				</div>
				<DialogFooter className="flex-wrap sm:justify-between">
					<div className="flex flex-wrap items-center gap-2">
						<Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => void confirmDeleteBook()}>Delete Lorebook</Button>
						<span className="hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
						{attachmentState !== null && !attachmentState.attachments.some((attachment) => attachment.owner === "conversation" && attachment.bookId === book.id) && <Button type="button" size="sm" variant="outline" disabled={attachmentPending} onClick={() => void updateAttachment({ type: "attach-chat", conversationId, bookId: book.id, expectedRevision: attachmentState.revision })}>Attach to Chat</Button>}
						<Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void exportBook()}><Download aria-hidden="true" /> Export</Button>
						<Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void executeLorebookCommand({ type: "duplicate", bookId: book.id, expectedRevision: book.revision }, "Lorebook duplicated.")}>Duplicate</Button>
					</div>
					<div className="flex items-center gap-2">
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

function ChatLoreSettingsLoading() {
	return <section className="flex flex-col gap-2 rounded-lg border border-border p-3" aria-label="Chat Lore settings" aria-busy="true">
		<h2 className="text-sm font-medium">Chat Lore settings</h2>
		<p className="sr-only" role="status">Loading Chat Lore settings…</p>
		<div className="flex flex-wrap items-end gap-2"><div className="h-14 w-28 animate-pulse rounded-md bg-muted/50" /><div className="h-14 w-28 animate-pulse rounded-md bg-muted/50" /><div className="h-9 w-28 animate-pulse rounded-md bg-muted/50" /></div>
		<div className="flex flex-col gap-1 text-sm"><strong>Attached Chat books</strong><div className="h-5 w-3/4 animate-pulse rounded bg-muted/50" /><div className="h-5 w-2/3 animate-pulse rounded bg-muted/50" /></div>
	</section>;
}

function LorebookLibraryLoading() {
	return <>
		<p className="sr-only" role="status">Loading Lorebooks…</p>
		{["first", "second", "third"].map((key) => <div className="h-14 animate-pulse rounded-lg border border-border bg-muted/50" key={key} />)}
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
				<Button variant="outline" disabled={pending} onClick={onDiscard}>Discard</Button>
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
				{entry.semantic.matches.length > 0 && <div><small>Strongest semantic match</small><p>“{entry.semantic.matches.reduce((strongest, match) => match.score > strongest.score ? match : strongest).sentence}” <strong>{entry.semantic.matches.reduce((strongest, match) => match.score > strongest.score ? match : strongest).score.toFixed(3)}</strong> (threshold {entry.semantic.threshold?.toFixed(2) ?? "Unavailable"})</p></div>}
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
		<Switch id={labelId} checked={checked} onCheckedChange={onCheckedChange} className="data-checked:bg-emerald-600 dark:data-checked:bg-emerald-500" />
	</span>;
}

function EntryEditor({ entry, onChange, onListChange, onDelete, pending }: { entry: LoreEntryFields; onChange: (entry: LoreEntryFields) => void; onListChange: (key: EntryListKey, value: string) => void; onDelete?: () => void; pending: boolean }) {
	const set = <K extends keyof LoreEntryFields>(key: K, value: LoreEntryFields[K]) => onChange({ ...entry, [key]: value });
	const listField = ([key, label]: readonly [EntryListKey, string]) => <label className="flex flex-col gap-1 text-xs text-muted-foreground" key={key}>{label}<Textarea className="min-h-16" value={joinList(entry[key])} onChange={(event) => onListChange(key, event.target.value)} /></label>;
	return <section className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3">
		<h3 className="text-sm font-medium">{onDelete ? "Edit entry" : "New entry"}</h3>
		<label className="flex flex-col gap-1 text-xs text-muted-foreground">Title<Input value={entry.title} onChange={(event) => set("title", event.target.value)} placeholder="Editor-only" /></label>
		<label className="flex flex-col gap-1 text-xs text-muted-foreground">Content<Textarea className="min-h-24" value={entry.content} onChange={(event) => set("content", event.target.value)} placeholder="Literal text inserted into the prompt" /></label>
		<div className="flex flex-col gap-2">
			<p className="text-xs text-muted-foreground">One expression per line. Commas are literal.</p>
			{entryMatchFields.map(listField)}
		</div>
		<details className="rounded-lg border border-border">
			<summary className="cursor-pointer px-3 py-2 text-xs font-medium">Secondary conditions</summary>
			<div className="flex flex-col gap-2 px-3 pb-3">{entryConditionFields.map(listField)}</div>
		</details>
		<div className="grid gap-2 sm:grid-cols-2">
			<StateToggle label="Always" checked={entry.always} onCheckedChange={(value) => set("always", value)} />
			<StateToggle label="Enabled" checked={entry.enabled} onCheckedChange={(value) => set("enabled", value)} />
			<StateToggle label="Case sensitive" checked={entry.caseSensitive} onCheckedChange={(value) => set("caseSensitive", value)} />
			<StateToggle label="Whole word" checked={entry.wholeWord} onCheckedChange={(value) => set("wholeWord", value)} />
		</div>
		<div className="flex flex-wrap items-end gap-3 text-sm">
			<div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Mode</span><Select value={entry.keywordMode} onValueChange={(value) => set("keywordMode", value === "regex" ? "regex" : "literal")}><SelectTrigger aria-label="Mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="literal">Literal</SelectItem><SelectItem value="regex">Regex</SelectItem></SelectContent></Select></div>
			{entry.keywordMode === "regex" && <label className="flex flex-col gap-1 text-xs text-muted-foreground">Regex flags<Input className="w-20" value={entry.regexFlags} onChange={(event) => set("regexFlags", event.target.value)} /></label>}
			<div className="flex flex-col gap-1"><span className="text-xs text-muted-foreground">Operator</span><Select value={entry.matchOperator} onValueChange={(value) => set("matchOperator", parseOperator(value))}><SelectTrigger aria-label="Operator"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="or">OR</SelectItem><SelectItem value="and">AND</SelectItem></SelectContent></Select></div>
			<label className="flex flex-col gap-1 text-xs text-muted-foreground">Priority<Input className="w-20" type="number" value={entry.priority} onChange={(event) => set("priority", Number(event.target.value))} /></label>
			<label className="flex flex-col gap-1 text-xs text-muted-foreground">Semantic threshold<Input className="w-24" type="number" min="0" max="1" step="0.01" value={entry.semanticThreshold ?? ""} onChange={(event) => set("semanticThreshold", event.target.value === "" ? null : Number(event.target.value))} /></label>
		</div>
		{onDelete && <Button type="button" size="sm" variant="destructive" className="self-start" disabled={pending} onClick={onDelete}>Delete entry</Button>}
	</section>;
}
