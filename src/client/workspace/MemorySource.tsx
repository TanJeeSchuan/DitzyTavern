import { Check, ChevronLeft, ChevronRight, Pencil, Trash2, X } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { formatJudgment, formatTimestamp } from "../lib/format";
import { loadMemoryTrace, type ConversationMemories } from "../memories";
import type { MemoryTraceStep } from "../../shared/contract/memory";
import { memorySourceState } from "./memory-source-state";
import type { ClaimDraft } from "./useConversationMemories";

type Source = ConversationMemories["sources"][number];
type Claim = Source["claims"][number];

/** @approved The retries a source card sends for its Message. */
type SourceCardActions = {
	retry: (source: Source) => void;
	retryIndex: (source: Source) => void;
};

/** @approved The corrections a claim row sends, and the label of its source's Message. */
type ClaimRowActions = {
	label: (messageId: number) => string;
	edit: (source: Source, index: number | null) => void;
	save: (source: Source, index: number, draft: ClaimDraft) => void;
	remove: (source: Source, index: number) => void;
};

export function MemorySourceCard({ conversationId, source, label, busy, enabled, excluded, actions, onNavigate, onStep, onClear }: {
	conversationId: number;
	source: Source | undefined;
	label: string;
	busy: boolean;
	enabled: boolean;
	excluded: boolean;
	actions: SourceCardActions;
	onNavigate: () => void;
	onStep: ((offset: -1 | 1) => void) | null;
	onClear: () => void;
}) {
	const [traceOpen, setTraceOpen] = useState(false);
	const { kind, text } = memorySourceState(source);
	const notes = [excluded ? "Author isn't in the story" : text, source?.ownership === "writer" && "Writer-maintained", source?.sourceChanged && "Source changed"].filter(Boolean).join(" · ");
	const error = source?.indexing.status === "failed" && source.status !== "failed" ? source.indexing.error ?? "Memory indexing failed." : source?.error;
	return <section className="memory-source-card" aria-label={`Memories from ${label}`} data-kind={kind}>
		<header>
			{onStep && <Button type="button" variant="ghost" size="icon-xs" aria-label="Previous Message" onClick={() => onStep(-1)}><ChevronLeft aria-hidden="true" /></Button>}
			<button type="button" className="memory-source-link" onClick={onNavigate}>{label}</button>
			{onStep && <Button type="button" variant="ghost" size="icon-xs" aria-label="Next Message" onClick={() => onStep(1)}><ChevronRight aria-hidden="true" /></Button>}
			<span className="memory-source-notes" data-working={kind === "working"}>{notes}</span>
			<Button type="button" variant="ghost" size="icon-xs" aria-label="Show every Message" onClick={onClear}><X aria-hidden="true" /></Button>
		</header>
		{kind === "failed" && source && <div className="memory-source-error">
			<p>{error ?? "Memory extraction failed."}</p>
			{source.indexing.status === "failed" && source.status !== "failed"
				? <Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => actions.retryIndex(source)}>Retry indexing</Button>
				: <Button type="button" size="xs" variant="outline" disabled={busy || !enabled} onClick={() => actions.retry(source)}>{source.ownership === "writer" ? "Reset…" : "Retry"}</Button>}
		</div>}
		{source?.status === "complete" && source.ownership === "writer" && source.claims.length === 0 && (
			<p className="memory-source-empty">All Memories were removed. Automatic updates are paused for this source.</p>
		)}
		{source && <div className="memory-source-actions">
			{kind !== "failed" && (
				<Button
					type="button"
					size="xs"
					variant="outline"
					disabled={busy || !enabled || kind === "working"}
					title={enabled ? undefined : "Memory is off for this Chat."}
					onClick={() => actions.retry(source)}
				>
				{kind === "working" ? "Remembering…" : source.status === "unprocessed" ? "Remember this Message" : source.ownership === "writer" ? "Reset and re-extract…" : "Re-extract"}
					</Button>
					)}
			{source.status !== "unprocessed" && <Button type="button" size="xs" variant="ghost" aria-expanded={traceOpen} onClick={() => setTraceOpen(!traceOpen)}>Pipeline trace</Button>}
		</div>}
		{traceOpen && source && <MemoryTraceView conversationId={conversationId} variantId={source.variantId} live={kind === "working"} onClose={() => setTraceOpen(false)} />}
	</section>;
}

export function MemoryClaimRow({ source, index, group, busy, editing, actions, onSelectSource, onNavigate }: {
	source: Source;
	index: number;
	group: string;
	busy: boolean;
	editing: boolean;
	actions: ClaimRowActions;
	onSelectSource: (source: Source) => void;
	onNavigate: (messageId: number) => void;
}) {
	const claim = source.claims[index]!;
	const [confirming, setConfirming] = useState(false);
	const editButton = useRef<HTMLButtonElement>(null);
	const wasEditing = useRef(editing);
	useEffect(() => { if (wasEditing.current && !editing) editButton.current?.focus(); wasEditing.current = editing; }, [editing]);
	if (editing)
		return (
			<article className="memory-claim" data-editing="true">
				<MemoryClaimEditor
					claim={claim}
					busy={busy}
					onCancel={() => actions.edit(source, null)}
					onSave={(draft) => actions.save(source, index, draft)}
				/>
			</article>
		);
	const { judgment } = claim;
	return <Collapsible.Root asChild><article className="memory-claim">
		<Collapsible.Trigger className="memory-claim-text">{claim.claim}</Collapsible.Trigger>
		<p className="memory-claim-meta">
			<button type="button" className="memory-source-link" onClick={() => onSelectSource(source)}>{actions.label(source.messageId)}</button>
			{claim.attribution !== group && <span> · {claim.attribution}</span>}
			{claim.writerMaintained && <span> · Edited</span>}
			{source.sourceChanged && <span> · Source changed</span>}
		</p>
		<div className="memory-claim-actions" data-confirming={confirming} onKeyDown={(event) => { if (event.key === "Escape") setConfirming(false); }}>
			{confirming ? (
				<>
					<Button type="button" size="xs" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
					<Button
						type="button"
						size="xs"
						variant="destructive"
						autoFocus
						disabled={busy}
						onClick={() => {
							setConfirming(false);
							actions.remove(source, index);
						}}
					>
						Remove Memory
					</Button>
				</>
			) : (
				<>
					<Button
						ref={editButton}
						type="button"
						size="icon-xs"
						variant="ghost"
						aria-label="Edit Memory"
						disabled={busy}
						onClick={() => actions.edit(source, index)}
					>
						<Pencil aria-hidden="true" />
					</Button>
					<Button
						type="button"
						size="icon-xs"
						variant="ghost"
						aria-label="Remove Memory"
						disabled={busy}
						onClick={() => setConfirming(true)}
					>
						<Trash2 aria-hidden="true" />
					</Button>
				</>
			)}
		</div>
		<Collapsible.Content className="memory-evidence">
			{claim.writerMaintained && <p className="memory-evidence-note">Original extraction evidence is provenance for the first wording; it does not prove the corrected text.</p>}
			{claim.evidence.map((evidence, position) => <figure key={position}>
				<blockquote>{evidence.excerpt}</blockquote>
				{evidence.messageId !== source.messageId && (
				<figcaption>
					<button type="button" className="memory-source-link" onClick={() => onNavigate(evidence.messageId)}>
						{actions.label(evidence.messageId)}
					</button>
				</figcaption>
			)}
			</figure>)}
			<p className="memory-evidence-note" title="Confidence values are Decision Model outputs, not proof of truth.">
				{(
				[
					["Support", judgment.support, judgment.confidence.support],
					["Attribution", judgment.attribution, judgment.confidence.attribution],
					["Usefulness", judgment.usefulness, judgment.confidence.usefulness],
				] as const
				)
				.map(([name, value, confidence]) => `${name} ${formatJudgment(value).toLowerCase()}${confidence === undefined ? "" : ` ${confidence.toFixed(2)}`}`).join(" · ")}
			</p>
		</Collapsible.Content>
	</article></Collapsible.Root>;
}

function MemoryClaimEditor({ claim, busy, onCancel, onSave }: { claim: Claim; busy: boolean; onCancel: () => void; onSave: (draft: ClaimDraft) => void }) {
	const [draft, setDraft] = useState({ claim: claim.claim, attribution: claim.attribution, people: claim.people.join(", ") });
	const submit = (event?: FormEvent) => {
		event?.preventDefault();
		onSave({
			claim: draft.claim,
			attribution: draft.attribution,
			people: draft.people.split(",").map((person) => person.trim()).filter(Boolean),
		});
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
		if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) submit();
	};
	return <form className="memory-editor" onSubmit={submit} onKeyDown={onKeyDown}>
		<textarea autoFocus aria-label="Memory" className="field-input memory-editor-claim" value={draft.claim} onChange={(event) => setDraft({ ...draft, claim: event.target.value })} />
		<label className="field">
			<span className="field-label">Attribution</span>
			<input
				className="field-input"
				value={draft.attribution}
				onChange={(event) => setDraft({ ...draft, attribution: event.target.value })}
			/>
		</label>
		<label className="field">
			<span className="field-label">People, separated by commas</span>
			<input
				className="field-input"
				value={draft.people}
				onChange={(event) => setDraft({ ...draft, people: event.target.value })}
			/>
		</label>
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
		<header>
			<span>
				Pipeline trace{steps
					? ` · ${steps.length} ${steps.length === 1 ? "step" : "steps"}`
					: ""}
				{live ? " · live" : ""}
			</span>
			<Button type="button" size="icon-xs" variant="ghost" aria-label="Hide pipeline trace" onClick={onClose}>
				<X aria-hidden="true" />
			</Button>
		</header>
		{error && <p className="import-problem" role="alert">{error}</p>}
		{steps?.length === 0 && <p className="memory-source-empty">No trace recorded yet. Retry extraction to capture one.</p>}
		<ol>{steps?.map((step, index) => <li key={index} data-failed={step.label === "Failed"}><details open={step.label === "Failed"}>
			<summary><span>{step.label}</span><time>{formatTimestamp(step.at)}{step.fields.elapsed ? ` · ${step.fields.elapsed}` : ""}</time></summary>
			{Object.entries(step.fields).map(([key, value]) => <div className="memory-trace-field" key={key}><span>{key}</span><pre>{value}</pre></div>)}
		</details></li>)}</ol>
	</div>;
}
