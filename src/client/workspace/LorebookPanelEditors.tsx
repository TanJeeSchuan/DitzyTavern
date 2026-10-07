import { useId, useState } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { LoreMatchTest } from "../lorebook-library";
import type { LoreAttachmentState } from "../lorebook-library";
import type { LoreEntryFields } from "../../shared/contract/lorebook";
import { entryConditionFields, entryMatchFields, joinList, parseOperator, type EntryListKey } from "./lorebook-entry-fields";

type LoreAttachment = LoreAttachmentState["attachments"][number];

function attachmentSource(attachment: LoreAttachment, participantName: (id: number) => string): string {
	if (attachment.scope === "chat") return "This Chat";
	const name = participantName(attachment.ownerId);
	if (attachment.reason === "not-controlled") return `${name}, inactive until ${name} holds a Control seat`;
	if (attachment.reason === "not-in-cast") return `${name}, inactive while outside the Cast`;
	return attachment.scope === "cast" ? `${name}, while in the Cast` : `${name}, while holding a Control seat`;
}

const numberInputClass = "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none";

interface ChatLoreSettingsProps {
	scanDepth: number;
	allowance: number;
	pending: boolean;
	onSave: (settings: { scanDepth: number; allowance: number }) => Promise<boolean>;
}

function ChatLoreSettings({ scanDepth, allowance, pending, onSave }: ChatLoreSettingsProps) {
	const [open, setOpen] = useState(false);
	const [draft, setDraft] = useState({ scanDepth, allowance });
	const unchanged = draft.scanDepth === scanDepth && draft.allowance === allowance;
	return <Popover open={open} onOpenChange={(next) => {
		if (next) setDraft({ scanDepth, allowance });
		setOpen(next);
	}}>
		<PopoverTrigger asChild>
			<Button type="button" size="xs" variant="ghost" className="text-muted-foreground" aria-label="Chat Lore settings">
				{scanDepth} {scanDepth === 1 ? "message" : "messages"} · {allowance.toLocaleString()} tokens max <Settings2 aria-hidden="true" />
			</Button>
		</PopoverTrigger>
		<PopoverContent align="end" className="w-64" onOpenAutoFocus={(event) => {
			event.preventDefault();
			if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus();
		}}>
			<form className="flex flex-col gap-3" onSubmit={(event) => {
				event.preventDefault();
				void onSave(draft).then((saved) => {
					if (saved) setOpen(false);
				});
			}}>
				<label className="flex flex-col gap-1 text-xs font-medium">
					Scan depth
					<span className="font-normal text-muted-foreground">Recent Messages checked for Keywords.</span>
					<Input
						className={numberInputClass}
						type="number"
						min="0"
						step="1"
						value={draft.scanDepth}
						onChange={(event) => setDraft({ ...draft, scanDepth: Math.max(0, Math.trunc(Number(event.target.value))) })}
					/>
				</label>
				<label className="flex flex-col gap-1 text-xs font-medium">
					Lore allowance
					<span className="font-normal text-muted-foreground">Estimated tokens lore may use per Generation.</span>
					<Input
						className={numberInputClass}
						type="number"
						min="0"
						step="1"
						value={draft.allowance}
						onChange={(event) => setDraft({ ...draft, allowance: Math.max(0, Math.trunc(Number(event.target.value))) })}
					/>
				</label>
				<Button type="submit" size="sm" className="self-end" disabled={pending || unchanged}>{pending ? "Saving…" : "Save"}</Button>
			</form>
		</PopoverContent>
	</Popover>;
}

function ChatLoreLoading() {
	return <section className="flex flex-col gap-2" aria-label="In this chat" aria-busy="true">
		<p className="sr-only" role="status">Loading Chat Lore settings…</p>
		<div className="flex items-center justify-between">
			<h2 className="text-sm font-semibold">In this chat</h2>
			<div className="h-5 w-40 animate-pulse rounded bg-muted/50" />
		</div>
		{["first", "second"].map((key) => <div className="flex flex-col gap-1 py-1.5" key={key}>
			<div className="h-4 w-2/5 animate-pulse rounded bg-muted/50" />
			<div className="h-3 w-1/4 animate-pulse rounded bg-muted/50" />
		</div>)}
	</section>;
}

function LorebookLibraryLoading() {
	return <>
		<li className="sr-only" role="status">Loading Lorebooks…</li>
		{["first", "second", "third"].map((key) => <li className="flex flex-col gap-1.5 px-3 py-3" aria-hidden="true" key={key}>
			<div className="h-4 w-1/3 animate-pulse rounded bg-muted/50" />
			<div className="h-3 w-1/2 animate-pulse rounded bg-muted/50" />
		</li>)}
	</>;
}

interface UnsavedLorebookDialogProps {
	open: boolean;
	pending: boolean;
	onKeepEditing: () => void;
	onDiscard: () => void;
	onSave: () => void;
}

function UnsavedLorebookDialog({ open, pending, onKeepEditing, onDiscard, onSave }: UnsavedLorebookDialogProps) {
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

interface MatchTesterProps {
	writing: string;
	onWritingChange: (value: string) => void;
	result: LoreMatchTest | null;
	error: string | null;
	pending: boolean;
	onTest: () => void;
}

function MatchTester({ writing, onWritingChange, result, error, pending, onTest }: MatchTesterProps) {
	return <section className="lore-match-tester flex flex-col gap-2" aria-labelledby="lore-match-tester-title">
		<div>
			<h3 id="lore-match-tester-title" className="text-sm font-medium">Match tester</h3>
			<p className="panel-intro">Test this Lorebook's saved entries against the writing below. Chat attachments, history, and the Prompt Preset do not affect this test.</p>
		</div>
		<Textarea className="min-h-24" value={writing} onChange={(event) => onWritingChange(event.target.value)} placeholder="Paste the writing to test…" aria-label="Writing to test" />
		<Button type="button" size="sm" className="self-start" disabled={pending} onClick={onTest}>Test matches</Button>
		{error !== null && <p className="settings-feedback-error" role="alert">{error}</p>}
		{result !== null && <MatchTesterResult result={result} />}
	</section>;
}

function MatchTesterResult({ result }: { result: LoreMatchTest }) {
	return <div className="lore-match-result" aria-label="Lore match test result">
		<div className="lore-match-result-heading">
			<strong>{result.mode === "semantic" ? "Match results" : result.mode === "keyword-fallback" ? "Keyword fallback" : "No entries"}</strong>
			<span>{result.matches.filter((entry) => entry.active).length} active entries</span>
		</div>
		{result.fallbackReason !== undefined && <p className="settings-feedback-error">{result.fallbackReason}</p>}
		{result.matches.length === 0
			? <p className="panel-intro">This Lorebook has no saved entries.</p>
			: result.matches.map((entry) => <details className="lore-match-entry" key={`${entry.bookId}-${entry.entryId}`} open={entry.active}>
				<summary>
					<span>{entry.title || "Untitled entry"}</span>
					<strong data-active={entry.active}>{entry.active ? "Active" : entry.skipped ? "Skipped" : "Not active"}</strong>
				</summary>
				<div className="lore-match-entry-body">
					{entry.semantic.matches.length > 0 && <SemanticTriggerSummary matches={entry.semantic.matches} threshold={entry.semantic.threshold ?? null} />}
					<div><small>Primary Keywords</small><p>{conditionSummary(entry.primary)}</p></div>
					<div><small>Secondary conditions</small>{secondarySummary(entry)}</div>
					{entry.reasons.length > 0 && <p className="lore-match-reasons">{entry.reasons.join(" · ")}</p>}
				</div>
			</details>)}
	</div>;
}

function SemanticTriggerSummary({ matches, threshold }: {
	matches: LoreMatchTest["matches"][number]["semantic"]["matches"];
	threshold: number | null;
}) {
	const strongest = matches.reduce((best, match) => match.score > best.score ? match : best);
	return <div>
		<small>Strongest Semantic Trigger</small>
		<p>“{strongest.trigger}” <strong>{strongest.score.toFixed(3)}</strong> (threshold {threshold === null ? "Unavailable" : threshold.toFixed(2)})</p>
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
	return <div className="flex flex-col gap-1">
		{conditions.map(([name, condition]) => <p key={name}>{name}: {conditionSummary(condition)}</p>)}
	</div>;
}

interface StateToggleProps {
	label: string;
	checked: boolean;
	onCheckedChange: (checked: boolean) => void;
}

function StateToggle({ label, checked, onCheckedChange }: StateToggleProps) {
	const labelId = useId();
	return <span className="flex items-center justify-between gap-2">
		<Label htmlFor={labelId} className="text-xs text-muted-foreground">{label}</Label>
		<Switch id={labelId} checked={checked} onCheckedChange={onCheckedChange} />
	</span>;
}

interface EntryEditorProps {
	entry: LoreEntryFields;
	onChange: (entry: LoreEntryFields) => void;
	onListChange: (key: EntryListKey, value: string) => void;
	onDelete?: () => void;
	pending: boolean;
}

function EntryEditor({ entry, onChange, onListChange, onDelete, pending }: EntryEditorProps) {
	const set = <K extends keyof LoreEntryFields>(key: K, value: LoreEntryFields[K]) => onChange({ ...entry, [key]: value });
	const hintId = useId();
	const listField = ([key, label]: readonly [EntryListKey, string]) => <div className="flex flex-col gap-1.5 text-xs text-muted-foreground" key={key}>
		<label htmlFor={`${hintId}-${key}`}>{label}</label>
		<Textarea
			id={`${hintId}-${key}`}
			className="min-h-16"
			aria-describedby={`${hintId}-${key}-hint`}
			value={joinList(entry[key])}
			onChange={(event) => onListChange(key, event.target.value)}
		/>
		<p id={`${hintId}-${key}-hint`}>One expression per line. Commas are literal.</p>
	</div>;
	const expressionGroup = (fields: readonly (readonly [EntryListKey, string])[]) => <div className="flex min-w-0 flex-col gap-3 rounded-xl border border-border p-4">
		{fields.map(listField)}
	</div>;
	return <section className="flex min-w-0 flex-col gap-4 rounded-xl border border-border p-5">
		<h3 className="text-sm font-medium">{onDelete ? "Edit entry" : "New entry"}</h3>
		<label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
			Title
			<Input value={entry.title} onChange={(event) => set("title", event.target.value)} placeholder="Editor-only" />
		</label>
		<label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
			Content
			<Textarea className="min-h-24" value={entry.content} onChange={(event) => set("content", event.target.value)} placeholder="Literal text inserted into the prompt" />
		</label>
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
			<div className="flex flex-col gap-1.5">
				<span className="text-xs text-muted-foreground">Mode</span>
				<Select value={entry.keywordMode} onValueChange={(value) => set("keywordMode", value === "regex" ? "regex" : "literal")}>
					<SelectTrigger aria-label="Mode"><SelectValue /></SelectTrigger>
					<SelectContent>
						<SelectItem value="literal">Literal</SelectItem>
						<SelectItem value="regex">Regex</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{entry.keywordMode === "regex" && <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
				Regex flags
				<Input className="w-20" value={entry.regexFlags} onChange={(event) => set("regexFlags", event.target.value)} />
			</label>}
			<div className="flex flex-col gap-1.5">
				<span className="text-xs text-muted-foreground">Operator</span>
				<Select value={entry.matchOperator} onValueChange={(value) => set("matchOperator", parseOperator(value))}>
					<SelectTrigger aria-label="Operator"><SelectValue /></SelectTrigger>
					<SelectContent>
						<SelectItem value="or">OR</SelectItem>
						<SelectItem value="and">AND</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
				Priority
				<Input className="w-20" type="number" value={entry.priority} onChange={(event) => set("priority", Number(event.target.value))} />
			</label>
		</div>
		{onDelete && <Button type="button" size="sm" variant="destructive" className="self-start" disabled={pending} onClick={onDelete}>Delete entry</Button>}
	</section>;
}

export {
	attachmentSource,
	ChatLoreLoading,
	ChatLoreSettings,
	EntryEditor,
	LorebookLibraryLoading,
	MatchTester,
	UnsavedLorebookDialog,
};
export type { LoreAttachment };
