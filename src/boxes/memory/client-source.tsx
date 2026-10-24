import { Button } from "@/box-sdk/client";
import { Check, ChevronLeft, ChevronRight, Pencil, Trash2, X } from "lucide-react";
import { Collapsible } from "radix-ui";
import { Value } from "@sinclair/typebox/value";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { type ConversationMemories, memoryCandidate } from "./contract";
import { memorySourceState } from "./client-source-state";
import type { ClaimDraft } from "./client-use-memories";

type Source = ConversationMemories["sources"][number];
type Claim = NonNullable<Source["claims"]>[number];

/** @approved What a source card asks for its Message: a digest now, or the Writer override reset. */
type SourceCardActions = {
	remember: (source: Source) => void;
	requestReset: (source: Source) => void;
};

/** @approved The corrections a claim row sends, and the label of its source's Message. */
type ClaimRowActions = {
	label: (messageId: number) => string;
	edit: (source: Source, index: number | null) => void;
	save: (source: Source, draft: ClaimDraft) => void;
	remove: (source: Source, index: number) => void;
};

export function MemorySourceCard({ source, label, busy, ready, excluded, actions, onNavigate, onStep, onClear }: {
	source: Source | undefined;
	label: string;
	busy: boolean;
	ready: boolean;
	excluded: boolean;
	actions: SourceCardActions;
	onNavigate: () => void;
	onStep: ((offset: -1 | 1) => void) | null;
	onClear: () => void;
}) {
	const { kind, text } = memorySourceState(source);
	const stale = source !== undefined && source.claims !== null && !source.digested && !source.overridden;
	const notes = [excluded ? "Author isn't in the story" : text, source?.overridden && "Writer-maintained", stale && "Source changed"].filter(Boolean).join(" · ");
	return <section className="memory-source-card" aria-label={`Memories from ${label}`} data-kind={kind}>
		<header>
			{onStep && <Button type="button" variant="ghost" size="icon-xs" aria-label="Previous Message" onClick={() => onStep(-1)}><ChevronLeft aria-hidden="true" /></Button>}
			<button type="button" className="memory-source-link" onClick={onNavigate}>{label}</button>
			{onStep && <Button type="button" variant="ghost" size="icon-xs" aria-label="Next Message" onClick={() => onStep(1)}><ChevronRight aria-hidden="true" /></Button>}
			<span className="memory-source-notes">{notes}</span>
			<Button type="button" variant="ghost" size="icon-xs" aria-label="Show every Message" onClick={onClear}><X aria-hidden="true" /></Button>
		</header>
		{kind === "failed" && source && <div className="memory-source-error">
			<p>{source.error}</p>
			<Button type="button" size="xs" variant="outline" disabled={busy || !ready} onClick={() => actions.remember(source)}>Retry</Button>
		</div>}
		{source?.overridden && source.claims?.length === 0 && (
			<p className="memory-source-empty">All Memories were removed. Reset to bring back the automatic ones.</p>
		)}
		{source && (kind === "unprocessed" || source.overridden) && <div className="memory-source-actions">
			{kind === "unprocessed" && !source.overridden && (
				<Button type="button" size="xs" variant="outline" disabled={busy || !ready} onClick={() => actions.remember(source)}>Remember this Message</Button>
			)}
			{source.overridden && (
				<Button type="button" size="xs" variant="outline" disabled={busy} onClick={() => actions.requestReset(source)}>Reset corrections…</Button>
			)}
		</div>}
	</section>;
}

export function MemoryClaimRow({ source, claim, index, group, busy, editing, actions, onSelectSource, onNavigate }: {
	source: Source;
	claim: Claim;
	index: number;
	group: string;
	busy: boolean;
	/** @approved The stored claim open for editing in this row, people as extraction or the writer named them rather than as labelled. */
	editing: Claim | null;
	actions: ClaimRowActions;
	onSelectSource: (source: Source) => void;
	onNavigate: (messageId: number) => void;
}) {
	// @approved
	//  A removal confirmation belongs to the claim it was opened for; a claim a
	//  digest replaced meanwhile closes it.
	const claimKey = JSON.stringify(claim);
	const [confirmed, setConfirmed] = useState<string | null>(null);
	const confirming = confirmed === claimKey;
	const setConfirming = (open: boolean) => setConfirmed(open ? claimKey : null);
	const editButton = useRef<HTMLButtonElement>(null);
	const wasEditing = useRef(editing !== null);
	useEffect(() => { if (wasEditing.current && editing === null) editButton.current?.focus(); wasEditing.current = editing !== null; }, [editing]);
	if (editing)
		return (
			<article className="memory-claim" data-editing="true">
				<MemoryClaimEditor
					claim={editing}
					busy={busy}
					onCancel={() => actions.edit(source, null)}
					onSave={(draft) => actions.save(source, draft)}
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
			{!source.digested && !source.overridden && <span> · Source changed</span>}
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
				.map(([name, value, confidence]) => `${name} ${value.replace("_", " ").toLowerCase()}${confidence === undefined ? "" : ` ${confidence.toFixed(2)}`}`).join(" · ")}
			</p>
		</Collapsible.Content>
	</article></Collapsible.Root>;
}

function MemoryClaimEditor({ claim, busy, onCancel, onSave }: { claim: Claim; busy: boolean; onCancel: () => void; onSave: (draft: ClaimDraft) => void }) {
	const [draft, setDraft] = useState({ claim: claim.claim, attribution: claim.attribution, people: claim.people.join(", ") });
	const corrected = { claim: draft.claim, attribution: draft.attribution, people: draft.people.split(",").map((person) => person.trim()).filter(Boolean) };
	const valid = Value.Check(memoryCandidate, { ...claim, ...corrected });
	const submit = (event?: FormEvent) => {
		event?.preventDefault();
		if (valid) onSave(corrected);
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (event.key === "Escape") { event.stopPropagation(); onCancel(); }
		if (event.key === "Enter" && !event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey)) submit();
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
			<Button type="submit" size="sm" disabled={busy || !valid}><Check aria-hidden="true" /> Save</Button>
		</div>
	</form>;
}
