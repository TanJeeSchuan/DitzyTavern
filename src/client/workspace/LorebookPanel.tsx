import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	applyLorebookCommand,
	exportNativeLorebook,
	getLorebook,
	importNativeLorebook,
	importSillyTavernLorebook,
	listLorebooks,
	parseNativeLorebook,
	testLorebookMatch,
	type LoreMatchTest,
	type Lorebook,
	type LorebookCommand,
} from "../lorebook-library";
import type { LoreEntry, LoreEntryFields } from "../../shared/contract/lorebook";
import type { SillyTavernJsonValue } from "../../shared/contract/prompt-preset";
import { PanelHeader } from "../PanelHeader";

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

	const openBook = async (id: number) => {
		setPending(true);
		try {
			const loaded = await getLorebook(id);
			if (loaded === null) { setNotice("That Lorebook no longer exists."); return; }
			setBook(loaded); setName(loaded.name); setDescription(loaded.description); setEntryId(null); setNotice(null);
		} catch { setNotice("The Lorebook could not be loaded."); } finally { setPending(false); }
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
			} else if (result.status === "deleted") {
				setBook(null); setEntryId(null); setBooks((items) => items.filter((item) => item.id !== result.bookId)); setNotice("Lorebook deleted.");
			} else if (result.status === "conflict") {
				setBook(result.currentBook); setName(result.currentBook.name); setDescription(result.currentBook.description); setNotice("This Lorebook changed elsewhere. Your saved view was refreshed.");
			} else setNotice(result.status === "invalid" ? result.reason : result.status === "not-found" ? "That Lorebook no longer exists." : "The Lorebook operation failed.");
		} finally { setPending(false); }
	};

	const create = () => void run({ type: "create", name: "New Lorebook", description: "" }, "Lorebook created.");
	const selectedEntry = book?.entries.find((entry) => entry.id === entryId);
	const filteredBooks = useMemo(() => books.filter((item) => item.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())), [books, search]);

	const saveEntry = () => {
		if (book === null) return;
		void run({ type: "save-entry", bookId: book.id, entryId: entryId ?? undefined, expectedRevision: book.revision, entry: entryDraft }, "Entry saved.");
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
		<PanelHeader title="Lorebooks" onClose={onClose} />
		<div className="panel-body flex flex-col gap-4" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
			<div className="flex items-center gap-2">
				<input ref={importInput} type="file" accept="application/json,.json" className="sr-only" aria-label="Import Lorebook JSON" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} />
				<Button size="sm" variant="outline" type="button" disabled={pending} onClick={() => importInput.current?.click()}><Upload aria-hidden="true" /> Import</Button>
				<Button size="sm" variant="outline" type="button" disabled={pending || book === null} onClick={async () => { if (!book) return; const value = await exportNativeLorebook(book.id); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" })); link.download = `${value.name}.json`; link.click(); URL.revokeObjectURL(link.href); }}><Download aria-hidden="true" /> Export</Button>
			</div>
			<div className="flex gap-2"><input className="field-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Lorebooks" aria-label="Search Lorebooks" /><Button type="button" size="sm" onClick={create} disabled={pending}><Plus aria-hidden="true" /> New</Button></div>
			{book === null ? <div className="flex flex-col gap-2" aria-label="Lorebook library">{filteredBooks.length === 0 ? <p className="panel-intro">No Lorebooks yet. Create one or import a JSON book.</p> : filteredBooks.map((item) => <button type="button" key={item.id} className="rounded-lg border border-border p-3 text-left hover:bg-muted/50" onClick={() => void openBook(item.id)}><strong>{item.name}</strong><span className="block text-xs text-muted-foreground">{item.entryCount} {item.entryCount === 1 ? "entry" : "entries"}</span></button>)}</div> : <>
				<div className="flex items-center justify-between"><Button type="button" size="sm" variant="ghost" onClick={() => { setBook(null); setEntryId(null); }}>← All Lorebooks</Button><div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => void run({ type: "duplicate", bookId: book.id, expectedRevision: book.revision }, "Lorebook duplicated.")}>Duplicate</Button><Button type="button" size="sm" variant="destructive" disabled={pending} onClick={() => { if (window.confirm(`Delete ${book.name}?`)) void run({ type: "delete", bookId: book.id, expectedRevision: book.revision }); }}>Delete</Button></div></div>
				<section className="flex flex-col gap-2"><h2 className="text-sm font-medium">Book details</h2><input className="field-input" value={name} onChange={(event) => setName(event.target.value)} aria-label="Lorebook name" /><textarea className="field-input min-h-16" value={description} onChange={(event) => setDescription(event.target.value)} aria-label="Lorebook description" /><Button type="button" size="sm" className="self-start" disabled={pending} onClick={() => void run({ type: "update-book", bookId: book.id, expectedRevision: book.revision, name, description }, "Book details saved.")}>Save book</Button></section>
				<MatchTester writing={testWriting} onWritingChange={(value) => { setTestWriting(value); setTestResult(null); setTestError(null); }} result={testResult} error={testError} pending={testPending} onTest={() => void runMatchTest()} />
				<section className="flex flex-col gap-2"><div className="flex items-center justify-between"><h2 className="text-sm font-medium">Entries</h2><Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => { setEntryId(null); setEntryDraft(blankEntry()); }}>New entry</Button></div>{book.entries.map((entry, index) => <div className="flex items-center gap-2 rounded-lg border border-border p-2" key={entry.id}><button type="button" className="min-w-0 flex-1 truncate text-left" onClick={() => { setEntryId(entry.id); setEntryDraft(fieldsOf(entry)); }}><strong>{entry.title || "Untitled entry"}</strong><span className="ml-2 text-xs text-muted-foreground">{entry.enabled ? "Enabled" : "Disabled"}</span></button><Button type="button" size="xs" variant="ghost" disabled={pending || index === 0} onClick={() => void run({ type: "reorder-entry", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, toPosition: index })}>↑</Button><Button type="button" size="xs" variant="ghost" disabled={pending || index === book.entries.length - 1} onClick={() => void run({ type: "reorder-entry", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, toPosition: index + 2 })}>↓</Button><Button type="button" size="xs" variant="ghost" disabled={pending} onClick={() => void run({ type: "set-entry-enabled", bookId: book.id, entryId: entry.id, expectedRevision: book.revision, enabled: !entry.enabled })}>{entry.enabled ? "Disable" : "Enable"}</Button></div>)}</section>
				{(entryId === null || selectedEntry !== undefined) && <EntryEditor entry={entryDraft} onChange={setEntryDraft} onListChange={updateList} onSave={saveEntry} onDelete={entryId === null ? undefined : () => void run({ type: "delete-entry", bookId: book.id, entryId, expectedRevision: book.revision }, "Entry deleted.")} pending={pending} />}
			</>}
			{notice !== null && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
		</div>
	</>;
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
				{entry.semantic.matches.length > 0 && <div><small>Strongest semantic match</small><p>“{entry.semantic.matches.reduce((strongest, match) => match.score > strongest.score ? match : strongest).sentence}” <strong>{entry.semantic.matches.reduce((strongest, match) => match.score > strongest.score ? match : strongest).score.toFixed(3)}</strong> (threshold {entry.semantic.threshold?.toFixed(2) ?? "—"})</p></div>}
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
	return <section className="flex flex-col gap-2 rounded-lg border border-border p-3"><h3 className="text-sm font-medium">{onDelete ? "Edit entry" : "New entry"}</h3><input className="field-input" value={entry.title} onChange={(event) => set("title", event.target.value)} placeholder="Editor-only title" aria-label="Entry title" /><textarea className="field-input min-h-24" value={entry.content} onChange={(event) => set("content", event.target.value)} placeholder="Literal content" aria-label="Entry content" />{entryListKeys.map((key) => <input key={key} className="field-input" value={joinList(entry[key])} onChange={(event) => onListChange(key, event.target.value)} placeholder={key} aria-label={key} />)}<div className="flex flex-wrap gap-3 text-sm"><label><input type="checkbox" checked={entry.always} onChange={(event) => set("always", event.target.checked)} /> Always</label><label><input type="checkbox" checked={entry.enabled} onChange={(event) => set("enabled", event.target.checked)} /> Enabled</label><label><input type="checkbox" checked={entry.caseSensitive} onChange={(event) => set("caseSensitive", event.target.checked)} /> Case sensitive</label><label><input type="checkbox" checked={entry.wholeWord} onChange={(event) => set("wholeWord", event.target.checked)} /> Whole word</label><label>Mode <select value={entry.keywordMode} onChange={(event) => set("keywordMode", event.target.value === "regex" ? "regex" : "literal")}><option value="literal">Literal</option><option value="regex">Regex</option></select></label><label>Operator <select value={entry.matchOperator} onChange={(event) => set("matchOperator", parseOperator(event.target.value))}><option value="or">OR</option><option value="and">AND</option></select></label><label>Priority <input className="field-input inline-block w-20" type="number" value={entry.priority} onChange={(event) => set("priority", Number(event.target.value))} /></label><label>Semantic threshold <input className="field-input inline-block w-24" type="number" min="0" max="1" step="0.01" value={entry.semanticThreshold ?? ""} onChange={(event) => set("semanticThreshold", event.target.value === "" ? null : Number(event.target.value))} /></label></div><Button type="button" size="sm" className="self-start" disabled={pending} onClick={onSave}>Save entry</Button>{onDelete && <Button type="button" size="sm" variant="destructive" className="self-start" disabled={pending} onClick={onDelete}>Delete entry</Button>}</section>;
}
