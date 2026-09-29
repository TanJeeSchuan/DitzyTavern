import { Gauge, Search } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cancelMemoryCatchup, correctMemory, loadConversationMemories, loadMemoryAllowance, loadMemoryCatchup, resetAndReextract, retryMemoryIndex, saveMemoryAllowance, startMemoryCatchup, type ConversationMemories, type ConversationMemoryAllowance, type MemoryCatchup } from "../memories";
import { PanelHeader } from "../PanelHeader";
import { MemoryCoverage } from "./MemoryCoverage";
import { MemorySourceGroup, type MemorySourceActions } from "./MemorySource";

type Source = ConversationMemories["sources"][number];
const conflictNotice = "This collection changed elsewhere. Review the current Memories before changing them again.";

export function MemoriesPanel({ conversationId, onClose, onNavigateSource, onOpenPanel }: {
	conversationId: number;
	onClose: () => void;
	onNavigateSource: (messageId: number) => void;
	onOpenPanel: (panel: "settings" | "prompts") => void;
}) {
	const [memories, setMemories] = useState<ConversationMemories | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [catchup, setCatchup] = useState<MemoryCatchup | null>(null);
	const [allowance, setAllowance] = useState<ConversationMemoryAllowance | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busyVariant, setBusyVariant] = useState<number | null>(null);
	const [catchupBusy, setCatchupBusy] = useState(false);
	const [editing, setEditing] = useState<{ variantId: number; revision: number; index: number } | null>(null);
	const [resetTarget, setResetTarget] = useState<Source | null>(null);
	const [query, setQuery] = useState("");
	const [person, setPerson] = useState("");
	const refresh = useCallback(async () => {
		try {
			const [loaded, run, settings] = await Promise.all([loadConversationMemories(conversationId), loadMemoryCatchup(conversationId), loadMemoryAllowance(conversationId)]);
			setMemories(loaded); setCatchup(run); setAllowance(settings); setLoadFailed(false);
		} catch { setLoadFailed(true); }
	}, [conversationId]);
	useEffect(() => {
		void refresh();
		const interval = window.setInterval(() => void refresh(), 5000);
		return () => window.clearInterval(interval);
	}, [refresh]);

	const replace = (collection: Source) => setMemories((current) => current && { ...current, sources: current.sources.map((item) => item.variantId === collection.variantId ? collection : item) });
	const act = async (source: Source, task: () => Promise<string | null>) => {
		setBusyVariant(source.variantId); setNotice(null);
		try { setNotice(await task()); } finally { setBusyVariant(null); }
	};
	const reextract = (source: Source) => act(source, async () => {
		const result = await resetAndReextract(conversationId, source.messageId, source.variantId, source.revision);
		if (result.outcome === "invalid") return result.reason;
		if (result.outcome === "conflict") { replace(result.collection); return conflictNotice; }
		await refresh();
		return null;
	});
	const catchupAction = async (task: () => Promise<MemoryCatchup>) => {
		setCatchupBusy(true); setNotice(null);
		try { setCatchup(await task()); await refresh(); } catch (error) { setNotice(error instanceof Error ? error.message : "History catch-up could not be changed."); } finally { setCatchupBusy(false); }
	};
	const actions: MemorySourceActions = {
		label: (messageId) => {
			const index = memories?.path.findIndex((entry) => entry.messageId === messageId) ?? -1;
			return index < 0 ? "Earlier Message" : `${memories?.path[index]?.author ?? "Unknown author"} · #${index + 1}`;
		},
		navigate: onNavigateSource,
		retry: (source) => { if (source.ownership === "writer") setResetTarget(source); else void reextract(source); },
		retryIndex: (source) => void act(source, async () => {
			const result = await retryMemoryIndex(conversationId, source.messageId, source.variantId, source.revision);
			if (result.outcome === "invalid") return result.reason;
			await refresh();
			return result.outcome === "conflict" ? conflictNotice : null;
		}),
		edit: (source, index) => setEditing(index === null ? null : { variantId: source.variantId, revision: source.revision, index }),
		save: (source, index, draft) => { if (editing?.variantId !== source.variantId || editing.index !== index) return; void act(source, async () => {
			const result = await correctMemory(conversationId, { messageId: source.messageId, variantId: source.variantId, expectedRevision: editing.revision, index, operation: "edit", ...draft });
			if (result.outcome === "invalid") return result.reason;
			replace(result.collection); setEditing(null);
			return result.outcome === "conflict" ? conflictNotice : null;
		}); },
		remove: (source, index) => void act(source, async () => {
			const result = await correctMemory(conversationId, { messageId: source.messageId, variantId: source.variantId, expectedRevision: source.revision, index, operation: "remove" });
			if (result.outcome === "invalid") return result.reason;
			replace(result.collection);
			return result.outcome === "conflict" ? conflictNotice : null;
		}),
	};

	const selected = memories?.sources.filter((source) => source.selected) ?? [];
	const alternatives = memories?.sources.filter((source) => !source.selected && source.claims.length > 0) ?? [];
	const attention = selected.filter((source) => source.status === "failed" || (source.status === "stale" && source.claims.length === 0) || source.indexing.status === "failed");
	const awaitingEmbedding = selected.filter((source) => source.indexing.status === "unconfigured").length;
	const people = [...selected.flatMap((source) => source.claims.flatMap((claim) => claim.people)).reduce((counts, name) => counts.set(name, (counts.get(name) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
	const needle = query.trim().toLowerCase();
	const filtering = needle !== "" || person !== "";
	const visibleClaims = (source: Source) => source.claims.map((claim, index) => ({ claim, index })).filter(({ claim }) => (!person || claim.people.includes(person)) && (!needle || [claim.claim, claim.attribution, ...claim.people].some((text) => text.toLowerCase().includes(needle))));
	const group = (source: Source) => {
		const claims = visibleClaims(source);
		const shown = claims.length > 0 || (!filtering && (source.status === "pending" || source.status === "running" || (source.status === "complete" && source.ownership === "writer")));
		return shown && <MemorySourceGroup key={source.variantId} conversationId={conversationId} source={source} claims={claims} busy={busyVariant === source.variantId} editingIndex={editing?.variantId === source.variantId ? editing.index : null} actions={actions} />;
	};
	const groups = selected.map(group).filter(Boolean);

	return <aside className="details-panel" data-open="true" aria-label="Memories">
		<PanelHeader title="Memories" onClose={onClose} actions={allowance && <MemoryAllowancePopover conversationId={conversationId} settings={allowance} onSaved={setAllowance} />} />
		<div className="panel-body memory-panel-body">
			{loadFailed && <div className="memory-callout" role="alert"><p>Memories could not be loaded.</p><Button type="button" size="xs" variant="outline" onClick={() => void refresh()}>Try again</Button></div>}
			{memories === null && !loadFailed && <div className="memory-loading" aria-label="Loading Memories"><span /><span /><span /><span /></div>}
			{memories !== null && <>
				{allowance?.enabled === false && <div className="memory-callout"><p>Memory is off for this Chat. Add a Memory Block to its Prompt Preset to start remembering. Saved Memories stay here.</p><Button type="button" size="xs" variant="outline" onClick={() => onOpenPanel("prompts")}>Open Prompt Presets</Button></div>}
				{memories.path.length > 0 && <MemoryCoverage path={memories.path} sources={new Map(selected.map((source) => [source.messageId, source]))} catchup={catchup} enabled={allowance?.enabled ?? false} busy={catchupBusy} label={actions.label} onStart={() => void catchupAction(() => startMemoryCatchup(conversationId))} onCancel={() => catchup && void catchupAction(() => cancelMemoryCatchup(conversationId, catchup.id))} onNavigate={onNavigateSource} />}
				{notice && <p className="import-problem" role="alert">{notice}</p>}
				{(attention.length > 0 || awaitingEmbedding > 0) && <section className="memory-attention" aria-label="Needs attention">
					<header><h3>Needs attention</h3><Button type="button" size="xs" variant="ghost" onClick={() => onOpenPanel("settings")}>Memory Settings</Button></header>
					{awaitingEmbedding > 0 && <p className="memory-attention-item"><span>{awaitingEmbedding} {awaitingEmbedding === 1 ? "source is" : "sources are"} waiting for embedding settings before their Memories can be recalled.</span></p>}
					{attention.map((source) => <div className="memory-attention-item" key={source.variantId}>
						<button type="button" className="memory-source-label" onClick={() => onNavigateSource(source.messageId)}>{actions.label(source.messageId)}</button>
						<span>{source.indexing.status === "failed" && source.status !== "failed" ? source.indexing.error ?? `${source.indexing.failedCount} Memories failed indexing.` : source.error ?? "Memory extraction failed."}</span>
						{source.indexing.status === "failed" && source.status !== "failed"
							? <Button type="button" size="xs" variant="outline" disabled={busyVariant === source.variantId} onClick={() => actions.retryIndex(source)}>Retry indexing</Button>
							: <Button type="button" size="xs" variant="outline" disabled={busyVariant === source.variantId} onClick={() => actions.retry(source)}>{source.ownership === "writer" ? "Reset…" : "Retry"}</Button>}
					</div>)}
				</section>}
				{selected.some((source) => source.claims.length > 0) && <div className="memory-filter">
					<label className="memory-search"><Search aria-hidden="true" /><input type="search" placeholder="Search Memories" aria-label="Search Memories" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
					{people.length > 1 && <ToggleGroup type="single" size="sm" variant="outline" spacing={4} className="memory-people" aria-label="Filter by person" value={person} onValueChange={setPerson}>
						{people.map(([name, count]) => <ToggleGroupItem key={name} value={name}>{name}<span>{count}</span></ToggleGroupItem>)}
					</ToggleGroup>}
				</div>}
				{groups.length > 0 ? <div className="memory-list">{groups}</div> : memories.path.length === 0 ? <p className="memory-empty">Memories appear here once the story has saved Messages.</p> : filtering ? <p className="memory-empty">No Memories match this filter.</p> : <p className="memory-empty">Nothing remembered yet.</p>}
				{alternatives.length > 0 && <details className="memory-alternatives">
					<summary>Unselected alternatives · {alternatives.length}</summary>
					<p className="memory-empty">These Memories stay saved with their Swipes and return if one is selected again.</p>
					<div className="memory-list">{alternatives.map(group)}</div>
				</details>}
			</>}
		</div>
		<Dialog open={resetTarget !== null} onOpenChange={(open) => { if (!open) setResetTarget(null); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Reset and re-extract?</DialogTitle>
					<DialogDescription>This discards every saved correction for {resetTarget ? actions.label(resetTarget.messageId) : "this source"} and resumes automatic updates. Its Memories are extracted again from the current Message.</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => setResetTarget(null)}>Keep corrections</Button>
					<Button type="button" variant="destructive" onClick={() => { if (resetTarget) void reextract(resetTarget); setResetTarget(null); }}>Reset and re-extract</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	</aside>;
}

function MemoryAllowancePopover({ conversationId, settings, onSaved }: { conversationId: number; settings: ConversationMemoryAllowance; onSaved: (settings: ConversationMemoryAllowance) => void }) {
	const [value, setValue] = useState(String(settings.allowance));
	const [revision, setRevision] = useState(settings.revision);
	const [pending, setPending] = useState(false);
	const [message, setMessage] = useState<{ tone: "note" | "problem"; text: string } | null>(null);
	const save = async (event: FormEvent) => {
		event.preventDefault();
		setPending(true); setMessage(null);
		const result = await saveMemoryAllowance(conversationId, revision, Number(value));
		if (result.outcome === "applied") { onSaved(result.settings); setRevision(result.settings.revision); setValue(String(result.settings.allowance)); setMessage({ tone: "note", text: "Saved." }); }
		else if (result.outcome === "conflict") { onSaved(result.currentSettings); setRevision(result.currentSettings.revision); setValue(String(result.currentSettings.allowance)); setMessage({ tone: "problem", text: "The allowance changed elsewhere. Review the current value before saving again." }); }
		else setMessage({ tone: "problem", text: result.reason });
		setPending(false);
	};
	return <Popover onOpenChange={(open) => { if (open) { setRevision(settings.revision); setValue(String(settings.allowance)); setMessage(null); } }}>
		<PopoverTrigger asChild><button type="button" className="icon-button" aria-label="Memory Allowance" title="Memory Allowance"><Gauge aria-hidden="true" /></button></PopoverTrigger>
		<PopoverContent align="end" className="memory-allowance">
			<PopoverHeader>
				<PopoverTitle>Memory Allowance</PopoverTitle>
				<PopoverDescription>A ceiling for recalled Memory text in one Generation. Zero keeps remembering on and retains saved Memories.</PopoverDescription>
			</PopoverHeader>
			<form onSubmit={(event) => void save(event)}>
				<label className="field"><span className="field-label">Estimated tokens</span><input className="field-input" type="number" min="0" step="1" value={value} onChange={(event) => setValue(event.target.value)} /></label>
				<Button type="submit" size="sm" disabled={pending || value === String(settings.allowance)}>Save</Button>
			</form>
			{message && <p className={message.tone === "problem" ? "import-problem" : "memory-empty"} role={message.tone === "problem" ? "alert" : "status"}>{message.text}</p>}
		</PopoverContent>
	</Popover>;
}
