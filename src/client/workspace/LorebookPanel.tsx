import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
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
const splitList = (value: string): string[] => value.split(",").map((part) => part.trim()).filter(Boolean);
const joinList = (value: string[]): string => value.join(", ");
const entryListKeys = ["keywords", "semanticTriggers", "requireAny", "requireAll", "excludeAny", "excludeAll"] as const;
const parseOperator = (value: string): LoreEntryFields["matchOperator"] => value === "and" ? "and" : "or";
const sameEntry = (left: LoreEntryFields, right: LoreEntryFields): boolean => JSON.stringify(left) === JSON.stringify(right);

type LeaveIntent =
	| { type: "close" }
	| { type: "library" }
	| { type: "book"; id: number }
	| { type: "entry"; id: number | null };

export function LorebookPanel({ conversationId, onClose, mutationsDisabled = false }: { conversationId: number; onClose: () => void; mutationsDisabled?: boolean }) {
	const [books, setBooks] = useState<Awaited<ReturnType<typeof listLorebooks>>>([]);
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
	const importInput = useRef<HTMLInputElement>(null);

	const refresh = useCallback(async () => {
		try {
			const loaded = await listLorebooks();
			setBooks(loaded);
			if (book !== null) {
				const current = await getLorebook(book.id);
				if (current !== null) {
					setBook(current);
					setName(current.name);
					setDescription(current.description);
				}
			}
		} catch { setNotice("The Lorebook library could not be loaded."); }
	}, [book]);

	// ==[HUMAN APPROVED]== The first load is intentionally initial-only; mutations update local state.
	useEffect(() => { void refresh(); }, []);
	useEffect(() => {
		void getLorebookAttachmentState(conversationId).then(setAttachmentState).catch(() => setNotice("Lorebook attachment settings could not be loaded."));
		void loadConversationPromptPreset(conversationId).then(setSelectedPreset).catch(() => setNotice("The selected Prompt Preset could not be loaded."));
	}, [conversationId]);

	const openBook = async (id: number) => {
		setPending(true);
		try {
			const loaded = await getLorebook(id);
			if (loaded === null) { setNotice("That Lorebook no longer exists."); return; }
			setBook(loaded); setName(loaded.name); setDescription(loaded.description); setEntryId(null); setNotice(null);
		} catch { setNotice("The Lorebook could not be loaded."); } finally { setPending(false); }
	};

	const selectedEntry = book?.entries.find((entry) => entry.id === entryId);
	const bookDirty = book !== null && (name !== book.name || description !== book.description);
	const entryDirty = book !== null && !sameEntry(entryDraft, selectedEntry === undefined ? blankEntry() : fieldsOf(selectedEntry));
	const dirty = bookDirty || entryDirty;

	const performLeave = (intent: LeaveIntent) => {
		if (intent.type === "close") {
			onClose();
		} else if (intent.type === "library") {
			setBook(null);
			setEntryId(null);
		} else if (intent.type === "book") {
			void openBook(intent.id);
		} else {
			setEntryId(intent.id);
			const target = book?.entries.find((entry) => entry.id === intent.id);
			setEntryDraft(target === undefined ? blankEntry() : fieldsOf(target));
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
		const intent = leaveIntent;
		setLeaveIntent(null);
		if (intent !== null) performLeave(intent);
	};

	const saveDirty = async (): Promise<boolean> => {
		if (book === null) return true;
		let current = book;
		if (bookDirty) {
			const result = await applyLorebookCommand({ type: "update-book", bookId: current.id, expectedRevision: current.revision, name, description });
			if (result.status !== "applied") {
				setNotice(result.status === "conflict" ? "This Lorebook changed elsewhere. Your saved view was refreshed." : result.status === "invalid" ? result.reason : "The Lorebook operation failed.");
				if (result.status === "conflict") {
					setBook(result.currentBook);
				}
				return false;
			}
			current = result.book;
			setBook(current);
			setName(current.name);
			setDescription(current.description);
		}
		if (entryDirty) {
			const result = await applyLorebookCommand({ type: "save-entry", bookId: current.id, entryId: entryId ?? undefined, expectedRevision: current.revision, entry: entryDraft });
			if (result.status !== "applied") {
				setNotice(result.status === "conflict" ? "This Lorebook changed elsewhere. Your saved view was refreshed." : result.status === "invalid" ? result.reason : "The Lorebook operation failed.");
				if (result.status === "conflict") setBook(result.currentBook);
				return false;
			}
			setBook(result.book);
		}
		return true;
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

	const run = async (command: LorebookCommand, success?: string) => {
		setPending(true);
		try {
			const result = await applyLorebookCommand(command);
			if (result.status === "applied") {
				setBook(result.book); setName(result.book.name); setDescription(result.book.description); setBooks((items) => {
					const summary = { id: result.book.id, name: result.book.name, description: result.book.description, revision: result.book.revision, entryCount: result.book.entries.length };
					return items.some((item) => item.id === result.book.id)
						? items.map((item) => item.id === result.book.id ? summary : item)
						: [...items, summary];
				}); setNotice(success ?? null);
				if (command.type === "save-entry" && command.entryId === undefined) {
					const saved = result.book.entries.at(-1);
					if (saved !== undefined) { setEntryId(saved.id); setEntryDraft(fieldsOf(saved)); }
				}
			} else if (result.status === "deleted") {
				setBook(null); setEntryId(null); setBooks((items) => items.filter((item) => item.id !== result.bookId)); setNotice("Lorebook deleted.");
			} else if (result.status === "conflict") {
				const preserveBookDraft = command.type === "update-book" && bookDirty;
				setBook(result.currentBook);
				if (!preserveBookDraft) { setName(result.currentBook.name); setDescription(result.currentBook.description); }
				setNotice("This Lorebook changed elsewhere. Your saved view was refreshed.");
			} else setNotice(result.status === "invalid" ? result.reason : result.status === "not-found" ? "That Lorebook no longer exists." : "The Lorebook operation failed.");
		} finally { setPending(false); }
	};

	const create = () => void run({ type: "create", name: "New Lorebook", description: "" }, "Lorebook created.");
	const filteredBooks = useMemo(() => books.filter((item) => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [books, search]);

	const saveEntry = () => {
		if (book === null) return;
		void run({ type: "save-entry", bookId: book.id, entryId: entryId ?? undefined, expectedRevision: book.revision, entry: entryDraft }, "Entry saved.");
	};
	const confirmDeleteBook = async () => {
		if (book === null) return;
		try {
			const impact = await getLorebookAttachmentImpact(book.id);
			const attachments = impact?.attachments.map((attachment) =>
				`${attachment.owner} ${attachment.ownerId} (${attachment.scope})`).join("\n") ?? "";
			const detail = attachments.length === 0
				? "It has no attachments."
				: `Deleting it also removes these attachments:\n${attachments}`;
			if (window.confirm(`Delete ${book.name}?\n\n${detail}`)) {
				await run({ type: "delete", bookId: book.id, expectedRevision: book.revision });
			}
		} catch (error) {
			setNotice(error instanceof Error ? error.message : "Unable to load Lorebook deletion impact.");
		}
	};
	const runMatchTest = async () => {
		setTestPending(true);
		setTestError(null);
		try {
			setTestResult(await testLorebookMatch(conversationId, testWriting));
		} catch (error) {
			setTestError(error instanceof Error ? error.message : "Lorebook matching could not be tested.");
		} finally {
			setTestPending(false);
		}
	};
	const updateAttachment = async (command: Parameters<typeof applyLorebookAttachmentCommand>[0]) => {
		setAttachmentPending(true);
		try {
			await applyLorebookAttachmentCommand(command);
			setAttachmentState(await getLorebookAttachmentState(conversationId));
		} catch { setNotice("Lorebook attachment settings could not be saved."); }
		finally { setAttachmentPending(false); }
	};
	const saveChatSettings = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (attachmentState === null) return;
		void updateAttachment({ type: "save-settings", conversationId, scanDepth: attachmentState.scanDepth, allowance: attachmentState.allowance });
	};
	const enableLoreSlot = async () => {
		if (selectedPreset === null) return;
		setAttachmentPending(true);
		try {
			const lore = selectedPreset.slots.find((slot) => slot.reference === "lore");
			const outcome = lore === undefined
				? await addPromptPresetReference(selectedPreset.id, "lore")
				: await setPromptPresetBlockEnabled(selectedPreset.id, lore.id, true);
			if (outcome.status !== "applied") throw new Error("The Prompt Preset rejected the Lore block change.");
			setSelectedPreset(await loadConversationPromptPreset(conversationId));
			setNotice(lore === undefined ? "Lore block added to the selected Prompt Preset." : "Lore block enabled in the selected Prompt Preset.");
		} catch (error) {
			setNotice(error instanceof Error ? error.message : "The Lore block could not be updated.");
		} finally { setAttachmentPending(false); }
	};
	const updateList = (key: keyof Pick<LoreEntryFields, "keywords" | "semanticTriggers" | "requireAny" | "requireAll" | "excludeAny" | "excludeAll">, value: string) => setEntryDraft((draft) => ({ ...draft, [key]: splitList(value) }));
	const importFile = async (file: File) => {
		setPending(true);
		try {
			const parsed: unknown = JSON.parse(await file.text());
			const native = parseNativeLorebook(JSON.stringify(parsed));
			// ==[HUMAN APPROVED]== SAFETY: JSON.parse returns the JSON value accepted by the SillyTavern import adapter.
			const result = native !== null ? await importNativeLorebook(native) : await importSillyTavernLorebook(parsed as SillyTavernJsonValue);
			if (result.status === "applied") { setBook(result.book); setName(result.book.name); setDescription(result.book.description); setBooks((items) => [...items, { id: result.book.id, name: result.book.name, description: result.book.description, revision: result.book.revision, entryCount: result.book.entries.length }]); setNotice(result.warnings.length === 0 ? "Lorebook imported." : result.warnings.join(" ")); }
			else setNotice(result.status === "invalid" ? result.reason : "The Lorebook import failed.");
		} catch { setNotice("The selected file is not valid JSON."); } finally { setPending(false); }
	};

	return <>
		<PanelHeader title="Lorebooks" onClose={() => requestLeave({ type: "close" })} />
		<div className="panel-body flex flex-col gap-4" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
			{attachmentState !== null && <section className="flex flex-col gap-2 rounded-lg border border-border p-3" aria-label="Chat Lore settings">
				<h2 className="text-sm font-medium">Chat Lore settings</h2>
				<form className="flex flex-wrap items-end gap-2" onSubmit={saveChatSettings}>
					<label className="flex flex-col gap-1 text-xs">Scan Messages<input className="field-input w-28" type="number" min="0" step="1" value={attachmentState.scanDepth} disabled={attachmentPending} onChange={(event) => setAttachmentState({ ...attachmentState, scanDepth: Math.max(0, Number(event.target.value)) })} /></label>
					<label className="flex flex-col gap-1 text-xs">Lore allowance<input className="field-input w-28" type="number" min="0" step="1" value={attachmentState.allowance} disabled={attachmentPending} onChange={(event) => setAttachmentState({ ...attachmentState, allowance: Math.max(0, Number(event.target.value)) })} /></label>
					<Button type="submit" size="sm" disabled={attachmentPending}>Save settings</Button>
				</form>
				<div className="flex flex-col gap-1 text-sm"><strong>Attached Chat books</strong>{attachmentState.attachments.filter((attachment) => attachment.owner === "conversation").length === 0 ? <p className="panel-intro">No Lorebooks are attached to this Chat.</p> : attachmentState.attachments.filter((attachment) => attachment.owner === "conversation").map((attachment) => <div className="flex items-center justify-between gap-2" key={attachment.id}><span>Book {attachment.bookId} <small>{attachment.eligible ? "Eligible" : attachment.reason}</small></span><span className="flex gap-1"><Button type="button" size="xs" variant="ghost" disabled={attachmentPending} onClick={() => void updateAttachment({ type: "attach-chat", conversationId, bookId: attachment.bookId, enabled: !attachment.enabled })}>{attachment.enabled ? "Disable" : "Enable"}</Button><Button type="button" size="xs" variant="ghost" disabled={attachmentPending} onClick={() => void updateAttachment({ type: "detach-chat", conversationId, bookId: attachment.bookId })}>Detach</Button></span></div>)}</div>
				{attachmentState.attachments.some((attachment) => attachment.enabled) && selectedPreset !== null && !selectedPreset.slots.some((slot) => slot.reference === "lore" && slot.enabled) && <div className="rounded-md border border-border p-2 text-sm"><p>Attached Lorebooks are inactive because the selected Prompt Preset has no enabled Lore block.</p><Button type="button" size="sm" variant="outline" disabled={attachmentPending} onClick={() => void enableLoreSlot()}>{selectedPreset.slots.some((slot) => slot.reference === "lore") ? "Enable Lore block" : "Add Lore block"}</Button></div>}
				{book !== null && !attachmentState.attachments.some((attachment) => attachment.owner === "conversation" && attachment.bookId === book.id) && <Button type="button" size="sm" variant="outline" disabled={attachmentPending} onClick={() => void updateAttachment({ type: "attach-chat", conversationId, bookId: book.id })}>Attach this book to Chat</Button>}
			</section>}
			<div className="flex items-center gap-2">
				<input ref={importInput} type="file" accept="application/json,.json" className="sr-only" aria-label="Import Lorebook JSON" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} />
				<Button size="sm" variant="outline" type="button" disabled={pending} onClick={() => importInput.current?.click()}><Upload aria-hidden="true" /> Import</Button>
				<Button size="sm" variant="outline" type="button" disabled={pending || book === null} onClick={async () => { if (!book) return; const value = await exportNativeLorebook(book.id); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })); link.download = `${value.name}.json`; link.click(); URL.revokeObjectURL(link.href); }}><Download aria-hidden="true" /> Export</Button>
			</div>
			<div className="flex gap-2"><input className="field-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Lorebooks" aria-label="Search Lorebooks" /><Button type="button" size="sm" onClick={create} disabled={pending}><Plus aria-hidden="true" /> New</Button></div>
			{book === null ? <div className="flex flex-col gap-2" aria-label="Lorebook library">{filteredBooks.length === 0 ? <p className="panel-intro">No Lorebooks yet. Create one or import a JSON book.</p> : filteredBooks.map((item) => <Button type="button" variant="outline" key={item.id} className="h-auto justify-start p-3 text-left" onClick={() => void openBook(item.id)}><span><strong>{item.name}</strong><span className="block text-xs text-muted-foreground">{item.entryCount} {item.entryCount === 1 ? "entry" : "entries"}</span></span></Button>)}</div> : <>
				<div className="flex items-center justify-between"><Button type="button" size="sm" variant="ghost" onClick={() => requestLeave({ type: "library" })}>← All Lorebooks</Button><div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void run({ type: "duplicate", bookId: book.id, expectedRevision: book.revision }, "Lorebook duplicated.")}>Duplicate</Button><Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => void confirmDeleteBook()}>Delete</Button></div></div>
				<section className="flex flex-col gap-2"><h2 className="text-sm font-medium">Book details</h2><input className="field-input" value={name} onChange={(event) => setName(event.target.value)} aria-label="Lorebook name" /><textarea className="field-input min-h-16" value={description} onChange={(event) => setDescription(event.target.value)} aria-label="Lorebook description" /><Button type="button" size="sm" className="self-start" disabled={pending} onClick={() => void run({ type: "update-book", bookId: book.id, expectedRevision: book.revision, name, description }, "Book details saved.")}>Save book</Button></section>
				<MatchTester writing={testWriting} onWritingChange={(value) => { setTestWriting(value); setTestResult(null); setTestError(null); }} result={testResult} error={testError} pending={testPending} onTest={() => void runMatchTest()} />
				<section className="flex flex-col gap-2"><div className="flex items-center justify-between"><h2 className="text-sm font-medium">Entries</h2><Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => requestLeave({ type: "entry", id: null })}>New entry</Button></div>{book.entries.map((entry, index) => <div className="flex items-center gap-2 rounded-lg border border-border p-2" key={entry.id}><Button type="button" variant="ghost" className="min-w-0 flex-1 justify-start truncate text-left" onClick={() => requestLeave({ type: "entry", id: entry.id })}><strong>{entry.title || "Untitled entry"}</strong><span className="ml-2 text-xs text-muted-foreground">{entry.enabled ? "Enabled" : "Disabled"}</span></Button><Button type="button" size="xs" variant="ghost" disabled={pending || index === 0} onClick={() => void run({ type: "reorder-entry", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, toPosition: index })}>↑</Button><Button type="button" size="xs" variant="ghost" disabled={pending || index === book.entries.length - 1} onClick={() => void run({ type: "reorder-entry", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, toPosition: index + 2 })}>↓</Button><Button type="button" size="xs" variant="ghost" disabled={pending} onClick={() => void run({ type: "set-entry-enabled", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, enabled: !entry.enabled })}>{entry.enabled ? "Disable" : "Enable"}</Button></div>)}</section>
				{(entryId === null || selectedEntry !== undefined) && <EntryEditor entry={entryDraft} onChange={setEntryDraft} onListChange={updateList} onSave={saveEntry} onDelete={entryId === null ? undefined : () => { if (window.confirm(`Delete ${entryDraft.title || "this entry"}?`)) void run({ type: "delete-entry", bookId: book.id, entryId, expectedRevision: book.revision }, "Entry deleted."); }} pending={pending} />}
			</>}
			{notice !== null && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
		</div>
		<UnsavedLorebookDialog open={leaveIntent !== null} pending={pending} onKeepEditing={() => setLeaveIntent(null)} onDiscard={discardAndLeave} onSave={() => void saveAndLeave()} />
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
		<div><h2 id="lore-match-tester-title" className="text-sm font-medium">Match tester</h2><p className="panel-intro">Test the current Chat writing without starting Generation. This does not change saved entries or historical Variants.</p></div>
		<textarea className="field-input min-h-24" value={writing} onChange={(event) => onWritingChange(event.target.value)} placeholder="Paste the writing to test…" aria-label="Writing to test" />
		<Button type="button" size="sm" className="self-start" disabled={pending} onClick={onTest}>Test matches</Button>
		{error !== null && <p className="settings-feedback-error" role="alert">{error}</p>}
		{result !== null && <MatchTesterResult result={result} />}
	</section>;
}

function MatchTesterResult({ result }: { result: LoreMatchTest }) {
	return <div className="lore-match-result" aria-label="Lore match test result">
		<div className="lore-match-result-heading"><strong>{result.mode === "semantic" ? "Semantic evaluation" : result.mode === "keyword-fallback" ? "Keyword fallback" : "No eligible Lorebooks"}</strong><span>{result.matches.filter((entry) => entry.active).length} active entries</span></div>
		{result.fallbackReason !== undefined && <p className="settings-feedback-error">{result.fallbackReason}</p>}
		{result.scan.length > 0 && <p className="lore-match-scan-note">Compared against {result.scan.length} scanned {result.scan.length === 1 ? "Message" : "Messages"}, plus the supplied writing.</p>}
		{result.matches.length === 0 ? <p className="panel-intro">No eligible entries were found.</p> : result.matches.map((entry) => <details className="lore-match-entry" key={`${entry.bookId}-${entry.entryId}`} open={entry.active}>
			<summary><span>{entry.title || "Untitled entry"}</span><strong data-active={entry.active}>{entry.active ? "Active" : entry.skipped ? "Skipped" : "Not active"}</strong></summary>
			<div className="lore-match-entry-body">
				{entry.semantic.matches.length > 0 && <div><small>Strongest semantic match</small><p>“{entry.semantic.matches.reduce((strongest, match) => match.score > strongest.score ? match : strongest).sentence}” <strong>{entry.semantic.matches.reduce((strongest, match) => match.score > strongest.score ? match : strongest).score.toFixed(3)}</strong> (threshold {entry.semantic.threshold?.toFixed(2) ?? "Unavailable"})</p></div>}
				<div><small>Primary Keywords</small><p>{entry.primary.matched ? `Matched: ${entry.primary.matchedExpressions.join(", ") || "semantic trigger"}` : "No primary match"}</p></div>
				<div><small>Secondary conditions</small><p>{secondarySummary(entry)}</p></div>
				{entry.reasons.length > 0 && <p className="lore-match-reasons">{entry.reasons.join(" · ")}</p>}
			</div>
		</details>)}
	</div>;
}

function secondarySummary(entry: LoreMatchTest["matches"][number]): string {
	const conditions = [
		["require any", entry.secondary.requireAny],
		["require all", entry.secondary.requireAll],
		["exclude any", entry.secondary.excludeAny],
		["exclude all", entry.secondary.excludeAll],
	] as const;
	const populated = conditions.filter(([, condition]) => condition.matchedExpressions.length > 0 || condition.missingExpressions.length > 0);
	return populated.length === 0 ? "No secondary conditions" : populated.map(([name, condition]) => `${name}: ${condition.matched ? "passed" : "failed"}`).join(" · ");
}

function EntryEditor({ entry, onChange, onListChange, onSave, onDelete, pending }: { entry: LoreEntryFields; onChange: (entry: LoreEntryFields) => void; onListChange: (key: keyof Pick<LoreEntryFields, "keywords" | "semanticTriggers" | "requireAny" | "requireAll" | "excludeAny" | "excludeAll">, value: string) => void; onSave: () => void; onDelete?: () => void; pending: boolean }) {
	const set = <K extends keyof LoreEntryFields>(key: K, value: LoreEntryFields[K]) => onChange({ ...entry, [key]: value });
	return <section className="flex flex-col gap-2 rounded-lg border border-border p-3"><h3 className="text-sm font-medium">{onDelete ? "Edit entry" : "New entry"}</h3><input className="field-input" value={entry.title} onChange={(event) => set("title", event.target.value)} placeholder="Editor-only title" aria-label="Entry title" /><textarea className="field-input min-h-24" value={entry.content} onChange={(event) => set("content", event.target.value)} placeholder="Literal content" aria-label="Entry content" />{entryListKeys.map((key) => <input key={key} className="field-input" value={joinList(entry[key])} onChange={(event) => onListChange(key, event.target.value)} placeholder={key} aria-label={key} />)}<div className="flex flex-wrap gap-3 text-sm"><label><input type="checkbox" checked={entry.always} onChange={(event) => set("always", event.target.checked)} /> Always</label><label><input type="checkbox" checked={entry.enabled} onChange={(event) => set("enabled", event.target.checked)} /> Enabled</label><label><input type="checkbox" checked={entry.caseSensitive} onChange={(event) => set("caseSensitive", event.target.checked)} /> Case sensitive</label><label><input type="checkbox" checked={entry.wholeWord} onChange={(event) => set("wholeWord", event.target.checked)} /> Whole word</label><label>Mode <select value={entry.keywordMode} onChange={(event) => set("keywordMode", event.target.value === "regex" ? "regex" : "literal")}><option value="literal">Literal</option><option value="regex">Regex</option></select></label>{entry.keywordMode === "regex" && <label>Regex flags <input className="field-input inline-block w-20" value={entry.regexFlags} onChange={(event) => set("regexFlags", event.target.value)} aria-label="Regex flags" /></label>}<label>Operator <select value={entry.matchOperator} onChange={(event) => set("matchOperator", parseOperator(event.target.value))}><option value="or">OR</option><option value="and">AND</option></select></label><label>Priority <input className="field-input inline-block w-20" type="number" value={entry.priority} onChange={(event) => set("priority", Number(event.target.value))} /></label><label>Semantic threshold <input className="field-input inline-block w-24" type="number" min="0" max="1" step="0.01" value={entry.semanticThreshold ?? ""} onChange={(event) => set("semanticThreshold", event.target.value === "" ? null : Number(event.target.value))} /></label></div><Button type="button" size="sm" className="self-start" disabled={pending} onClick={onSave}>Save entry</Button>{onDelete && <Button type="button" size="sm" variant="destructive" className="self-start" disabled={pending} onClick={onDelete}>Delete entry</Button>}</section>;
}
