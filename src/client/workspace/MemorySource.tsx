import { Check, Ellipsis, Pencil, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { loadMemoryTrace, type ConversationMemories } from "../memories";
import type { MemoryTraceStep } from "../../shared/contract/memory";

type Source = ConversationMemories["sources"][number];
type Claim = Source["claims"][number];
export type ClaimDraft = { claim: string; attribution: string; people: string[] };
export interface MemorySourceActions {
	label: (messageId: number) => string;
	navigate: (messageId: number) => void;
	retry: (source: Source) => void;
	retryIndex: (source: Source) => void;
	edit: (source: Source, index: number | null) => void;
	save: (source: Source, index: number, draft: ClaimDraft) => void;
	remove: (source: Source, index: number) => void;
}

export function MemorySourceGroup({ conversationId, source, claims, busy, editingIndex, actions }: {
	conversationId: number;
	source: Source;
	claims: { claim: Claim; index: number }[];
	busy: boolean;
	editingIndex: number | null;
	actions: MemorySourceActions;
}) {
	const [traceOpen, setTraceOpen] = useState(false);
	const working = source.status === "pending" || source.status === "running";
	const notes = [!source.selected && "Alternative", source.ownership === "writer" && "Writer-maintained", source.sourceChanged && "Source changed", working && (source.status === "pending" ? "Queued" : "Remembering")].filter(Boolean).join(" · ");
	return <section className="memory-source" data-selected={source.selected}>
		<header className="memory-source-header">
			<button type="button" className="memory-source-label" onClick={() => actions.navigate(source.messageId)}>{actions.label(source.messageId)}</button>
			{notes && <span className="memory-source-notes" data-working={working}>{notes}</span>}
			<DropdownMenu>
				<DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon-xs" aria-label={`Actions for ${actions.label(source.messageId)}`}><Ellipsis aria-hidden="true" /></Button></DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-48">
					<DropdownMenuItem onSelect={() => actions.navigate(source.messageId)}>Go to Message</DropdownMenuItem>
					{source.status !== "unprocessed" && <DropdownMenuItem onSelect={() => setTraceOpen(!traceOpen)}>{traceOpen ? "Hide pipeline trace" : "Show pipeline trace"}</DropdownMenuItem>}
					{source.indexing.status === "failed" && <DropdownMenuItem disabled={busy} onSelect={() => actions.retryIndex(source)}>Retry indexing</DropdownMenuItem>}
					<DropdownMenuSeparator />
					<DropdownMenuItem disabled={busy || working || !source.selected} onSelect={() => actions.retry(source)}>{source.ownership === "writer" ? "Reset and re-extract…" : "Retry extraction"}</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</header>
		{traceOpen && <MemoryTraceView conversationId={conversationId} variantId={source.variantId} live={working} onClose={() => setTraceOpen(false)} />}
		{working && claims.length === 0 && <div className="memory-claim-skeleton" aria-hidden="true"><span /><span /></div>}
		{source.status === "complete" && source.ownership === "writer" && source.claims.length === 0 && <p className="memory-source-empty">All Memories were removed. Automatic updates are paused for this source.</p>}
		{claims.map(({ claim, index }) => <MemoryClaimRow
			key={index}
			claim={claim}
			busy={busy}
			editing={editingIndex === index}
			actions={actions}
			onEdit={() => actions.edit(source, index)}
			onCancel={() => actions.edit(source, null)}
			onSave={(draft) => actions.save(source, index, draft)}
			onRemove={() => actions.remove(source, index)}
		/>)}
	</section>;
}

const judgmentWord = (value: string) => value.replace("_", " ").replace(/^./, (letter) => letter.toUpperCase());

function MemoryClaimRow({ claim, busy, editing, actions, onEdit, onCancel, onSave, onRemove }: {
	claim: Claim;
	busy: boolean;
	editing: boolean;
	actions: MemorySourceActions;
	onEdit: () => void;
	onCancel: () => void;
	onSave: (draft: ClaimDraft) => void;
	onRemove: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const editButton = useRef<HTMLButtonElement>(null);
	const wasEditing = useRef(editing);
	useEffect(() => { if (wasEditing.current && !editing) editButton.current?.focus(); wasEditing.current = editing; }, [editing]);
	if (editing) return <article className="memory-claim" data-editing="true"><MemoryClaimEditor claim={claim} busy={busy} onCancel={onCancel} onSave={onSave} /></article>;
	const { judgment } = claim;
	return <article className="memory-claim">
		<p className="memory-claim-text">{claim.claim}</p>
		<p className="memory-claim-meta">{claim.attribution}{claim.people.length > 0 && <span> · {claim.people.join(", ")}</span>}{claim.writerMaintained && <span> · Edited</span>}</p>
		<div className="memory-claim-actions" data-confirming={confirming} onKeyDown={(event) => { if (event.key === "Escape") setConfirming(false); }}>
			{confirming
				? <><Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button><Button type="button" size="xs" variant="destructive" autoFocus disabled={busy} onClick={() => { setConfirming(false); onRemove(); }}>Remove Memory</Button></>
				: <><Button ref={editButton} type="button" size="icon-xs" variant="ghost" aria-label="Edit Memory" disabled={busy} onClick={onEdit}><Pencil aria-hidden="true" /></Button><Button type="button" size="icon-xs" variant="ghost" aria-label="Remove Memory" disabled={busy} onClick={() => setConfirming(true)}><Trash2 aria-hidden="true" /></Button></>}
		</div>
		<details className="memory-evidence">
			<summary>Evidence</summary>
			{claim.writerMaintained && <p className="memory-evidence-note">Original extraction evidence is provenance for the first wording; it does not prove the corrected text.</p>}
			{claim.evidence.map((evidence, index) => <figure key={index}>
				<blockquote>{evidence.excerpt}</blockquote>
				<figcaption><button type="button" onClick={() => actions.navigate(evidence.messageId)}>{actions.label(evidence.messageId)}</button></figcaption>
			</figure>)}
			<dl className="memory-judgment">
				{([["Support", judgment.support, judgment.confidence.support], ["Attribution", judgment.attribution, judgment.confidence.attribution], ["Usefulness", judgment.usefulness, judgment.confidence.usefulness]] as const).map(([name, value, confidence]) => <div key={name}>
					<dt>{name}</dt>
					<dd>{judgmentWord(value)}</dd>
					<dd className="memory-confidence"><span style={{ width: `${Math.round(confidence * 100)}%` }} /></dd>
					<dd className="memory-confidence-value">{confidence.toFixed(2)}</dd>
				</div>)}
			</dl>
			<p className="memory-evidence-note">Confidence values are Jev model outputs, not proof of truth.</p>
		</details>
	</article>;
}

function MemoryClaimEditor({ claim, busy, onCancel, onSave }: { claim: Claim; busy: boolean; onCancel: () => void; onSave: (draft: ClaimDraft) => void }) {
	const [draft, setDraft] = useState({ claim: claim.claim, attribution: claim.attribution, people: claim.people.join(", ") });
	const submit = (event?: FormEvent) => { event?.preventDefault(); onSave({ claim: draft.claim, attribution: draft.attribution, people: draft.people.split(",").map((person) => person.trim()).filter(Boolean) }); };
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submit();
	};
	return <form className="memory-editor" onSubmit={submit} onKeyDown={onKeyDown}>
		<textarea autoFocus aria-label="Memory" className="field-input memory-editor-claim" value={draft.claim} onChange={(event) => setDraft({ ...draft, claim: event.target.value })} />
		<label className="field"><span className="field-label">Attribution</span><input className="field-input" value={draft.attribution} onChange={(event) => setDraft({ ...draft, attribution: event.target.value })} /></label>
		<label className="field"><span className="field-label">People, separated by commas</span><input className="field-input" value={draft.people} onChange={(event) => setDraft({ ...draft, people: event.target.value })} /></label>
		<div className="memory-editor-actions">
			<span>Ctrl+Enter saves · Esc cancels</span>
			<Button type="button" size="sm" variant="ghost" onClick={onCancel}><X aria-hidden="true" /> Cancel</Button>
			<Button type="submit" size="sm" disabled={busy}><Check aria-hidden="true" /> Save</Button>
		</div>
	</form>;
}

function MemoryTraceView({ conversationId, variantId, live, onClose }: { conversationId: number; variantId: number; live: boolean; onClose: () => void }) {
	const [steps, setSteps] = useState<MemoryTraceStep[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const load = () => { void loadMemoryTrace(conversationId, variantId).then((loaded) => { setSteps(loaded); setError(null); }).catch(() => setError("Pipeline trace could not be loaded.")); };
		load();
		if (!live) return;
		const interval = window.setInterval(load, 2000);
		return () => window.clearInterval(interval);
	}, [live, conversationId, variantId]);
	return <div className="memory-trace">
		<header><span>Pipeline trace{steps ? ` · ${steps.length} ${steps.length === 1 ? "step" : "steps"}` : ""}{live ? " · live" : ""}</span><Button type="button" size="icon-xs" variant="ghost" aria-label="Hide pipeline trace" onClick={onClose}><X aria-hidden="true" /></Button></header>
		{error && <p className="import-problem" role="alert">{error}</p>}
		{steps?.length === 0 && <p className="memory-source-empty">No trace recorded yet. Retry extraction to capture one.</p>}
		<ol>{steps?.map((step, index) => <li key={index} data-failed={step.label === "Failed"}><details open={step.label === "Failed"}>
			<summary><span>{step.label}</span><time>{new Date(step.at).toLocaleTimeString()}{step.fields.elapsed ? ` · ${step.fields.elapsed}` : ""}</time></summary>
			{Object.entries(step.fields).map(([key, value]) => <div className="memory-trace-field" key={key}><span>{key}</span><pre>{value}</pre></div>)}
		</details></li>)}</ol>
	</div>;
}
