import { Search } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ConversationMemories } from "../memories";
import { PanelHeader } from "../PanelHeader";
import { MemoryAllowancePopover } from "./MemoryAllowancePopover";
import { MemoryCoverage } from "./MemoryCoverage";
import { MemoryLabelMergeDialog } from "./MemoryLabelMergeDialog";
import { MemorySourceGroup } from "./MemorySource";
import { memorySourceState } from "./memory-source-state";
import { useConversationMemories } from "./useConversationMemories";

type Source = ConversationMemories["sources"][number];

export function MemoriesPanel({ conversationId, conversationRevision, onClose, onNavigateSource, onOpenPanel }: {
	conversationId: number;
	conversationRevision: number;
	onClose: () => void;
	onNavigateSource: (messageId: number) => void;
	onOpenPanel: (panel: "memory" | "prompts") => void;
}) {
	const { status, memories, catchup, allowance, notice, busy, catchupBusy, editing, resetTarget, actions, refresh, setAllowance, startCatchup, cancelCatchup, confirmReset, cancelReset, labelsMerged } = useConversationMemories(conversationId, conversationRevision);
	const [query, setQuery] = useState("");
	const [person, setPerson] = useState("");
	const [mergingLabels, setMergingLabels] = useState(false);

	const selected = memories?.sources.filter((source) => source.selected) ?? [];
	const alternatives = memories?.sources.filter((source) => !source.selected && source.claims.length > 0) ?? [];
	const attention = selected.filter((source) => memorySourceState(source).needsAttention);
	const awaitingEmbedding = selected.filter((source) => source.indexing.status === "unconfigured").length;
	const people = [...selected.flatMap((source) => source.claims.flatMap((claim) => [...new Set(claim.people)])).reduce((counts, name) => counts.set(name, (counts.get(name) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
	const needle = query.trim().toLowerCase();
	const filtering = needle !== "" || person !== "";
	const visibleClaims = (source: Source) => source.claims.map((claim, index) => ({ claim, index })).filter(({ claim }) => (!person || claim.people.includes(person)) && (!needle || [claim.claim, claim.attribution, ...claim.people].some((text) => text.toLowerCase().includes(needle))));
	const group = (source: Source) => {
		const claims = visibleClaims(source);
		const shown = claims.length > 0 || (!filtering && (memorySourceState(source).kind === "working" || (source.status === "complete" && source.ownership === "writer")));
		return shown && <MemorySourceGroup key={source.variantId} conversationId={conversationId} source={source} claims={claims} busy={busy.has(source.variantId)} editingIndex={editing?.variantId === source.variantId ? editing.index : null} actions={actions} onNavigate={onNavigateSource} />;
	};
	const groups = selected.map(group).filter(Boolean);

	return <aside className="details-panel" data-open="true" aria-label="Memories">
		<PanelHeader title="Memories" onClose={onClose} actions={allowance && <MemoryAllowancePopover conversationId={conversationId} settings={allowance} onSaved={setAllowance} />} />
		<div className="panel-body memory-panel-body">
			{status === "failed" && <div className="memory-callout" role="alert"><p>Memories could not be loaded.</p><Button type="button" size="xs" variant="outline" onClick={() => void refresh()}>Try again</Button></div>}
			{status === "stale" && <div className="memory-callout" role="status"><p>Could not refresh Memories. Showing the last loaded view.</p><Button type="button" size="xs" variant="outline" onClick={() => void refresh()}>Try again</Button></div>}
			{status === "loading" && <div className="memory-loading" aria-label="Loading Memories"><span /><span /><span /><span /></div>}
			{memories !== null && <>
				{allowance?.enabled === false && <div className="memory-callout"><p>Memory is off for this Chat. Add a Memory Block to its Prompt Preset to start remembering. Saved Memories stay here.</p><Button type="button" size="xs" variant="outline" onClick={() => onOpenPanel("prompts")}>Open Prompt Presets</Button></div>}
				{memories.path.length > 0 && <MemoryCoverage path={memories.path} sources={new Map(selected.map((source) => [source.messageId, source]))} catchup={catchup} enabled={allowance?.enabled ?? false} busy={catchupBusy} label={actions.label} onStart={() => void startCatchup()} onCancel={() => void cancelCatchup()} onNavigate={onNavigateSource} />}
				{notice && <p className="import-problem" role="alert">{notice}</p>}
				{(attention.length > 0 || awaitingEmbedding > 0) && <section className="memory-attention" aria-label="Needs attention">
					<header><h3>Needs attention</h3><Button type="button" size="xs" variant="ghost" onClick={() => onOpenPanel("memory")}>Memory Settings</Button></header>
					{awaitingEmbedding > 0 && <p className="memory-attention-item"><span>{awaitingEmbedding} {awaitingEmbedding === 1 ? "source is" : "sources are"} waiting for embedding settings before their Memories can be recalled.</span></p>}
					{attention.map((source) => <div className="memory-attention-item" key={source.variantId}>
						<button type="button" className="memory-source-label" onClick={() => onNavigateSource(source.messageId)}>{actions.label(source.messageId)}</button>
						<span>{source.indexing.status === "failed" && source.status !== "failed" ? source.indexing.error ?? "Memory indexing failed." : source.error ?? "Memory extraction failed."}</span>
						{source.indexing.status === "failed" && source.status !== "failed"
							? <Button type="button" size="xs" variant="outline" disabled={busy.has(source.variantId)} onClick={() => actions.retryIndex(source)}>Retry indexing</Button>
							: <Button type="button" size="xs" variant="outline" disabled={busy.has(source.variantId)} onClick={() => actions.retry(source)}>{source.ownership === "writer" ? "Reset…" : "Retry"}</Button>}
					</div>)}
				</section>}
				{memories.sources.some((source) => source.claims.length > 0) && <div className="memory-filter">
					<label className="search-field"><Search aria-hidden="true" /><input type="search" placeholder="Search Memories" aria-label="Search Memories" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
					{people.length > 1 && <ToggleGroup type="single" size="sm" variant="outline" spacing={4} className="memory-people" aria-label="Filter by person" value={person} onValueChange={setPerson}>
						{people.map(([name, count]) => <ToggleGroupItem key={name} value={name}>{name}<span>{count}</span></ToggleGroupItem>)}
					</ToggleGroup>}
					{memories.sources.some((source) => source.claims.some((claim) => claim.people.length > 0)) && <Button type="button" size="xs" variant="ghost" className="self-start" onClick={() => setMergingLabels(true)}>Merge labels</Button>}
				</div>}
				{groups.length > 0 ? <div className="memory-list">{groups}</div> : memories.path.length === 0 ? <p className="memory-empty">Memories appear here once the story has saved Messages.</p> : filtering ? <p className="memory-empty">No Memories match this filter.</p> : <p className="memory-empty">Nothing remembered yet.</p>}
				{alternatives.length > 0 && <details className="memory-alternatives">
					<summary>Unselected alternatives · {alternatives.length}</summary>
					<p className="memory-empty">These Memories stay saved with their Swipes and return if one is selected again.</p>
					<div className="memory-list">{alternatives.map(group)}</div>
				</details>}
			</>}
		</div>
		{mergingLabels && memories && <MemoryLabelMergeDialog conversationId={conversationId} memories={memories} onClose={() => setMergingLabels(false)} onMerged={(updated, destination) => { labelsMerged(updated, destination); setPerson(""); setMergingLabels(false); }} />}
		<Dialog open={resetTarget !== null} onOpenChange={(open) => { if (!open) cancelReset(); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Reset and re-extract?</DialogTitle>
					<DialogDescription>This discards every saved correction for {resetTarget ? actions.label(resetTarget.messageId) : "this source"} and resumes automatic updates. Its Memories are extracted again from the current Message.</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={cancelReset}>Keep corrections</Button>
					<Button type="button" variant="destructive" onClick={confirmReset}>Reset and re-extract</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	</aside>;
}
