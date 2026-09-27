import { Check, Pencil, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cancelMemoryCatchup, correctMemory, loadConversationMemories, loadMemoryAllowance, loadMemoryCatchup, loadMemoryTrace, resetAndReextract, retryMemoryIndex, saveMemoryAllowance, startMemoryCatchup, type ConversationMemoryAllowance, type MemoryCatchup } from "../memories";
import { PanelHeader } from "../PanelHeader";
import { useAsyncEffect } from "../lib/use-async";
import type { MemoryTraceStep } from "../../shared/contract/memory";

type State = { status: "loading" | "ready" | "failed"; sources: Awaited<ReturnType<typeof loadConversationMemories>>["sources"]; error: string | null; pendingMessageId: number | null };
type Editing = { messageId: number; revision: number; index: number; claim: string; attribution: string; people: string };

export function MemoriesPanel({ conversationId, onClose, onNavigateSource }: { conversationId: number; onClose: () => void; onNavigateSource: (messageId: number) => void }) {
	const [state, setState] = useState<State>({ status: "loading", sources: [], error: null, pendingMessageId: null });
	const [editing, setEditing] = useState<Editing | null>(null);
	const [catchup, setCatchup] = useState<MemoryCatchup | null>(null);
	const [catchupPending, setCatchupPending] = useState(false);
	const [memoryEnabled, setMemoryEnabled] = useState(false);
	const editButtonRef = useRef<HTMLButtonElement>(null);
	const refresh = useCallback(async () => {
		try { const [result, run, allowance] = await Promise.all([loadConversationMemories(conversationId), loadMemoryCatchup(conversationId), loadMemoryAllowance(conversationId)]); setState((current) => ({ ...current, status: "ready", sources: result.sources, error: null })); setCatchup(run); setMemoryEnabled(allowance.enabled); }
		catch { setState((current) => ({ ...current, status: "failed", error: "Memories could not be loaded. Try again." })); }
	}, [conversationId]);
	useAsyncEffect((cancelled) => { void Promise.all([loadConversationMemories(conversationId), loadMemoryCatchup(conversationId)]).then(([result, run]) => { if (!cancelled()) { setState((current) => ({ ...current, status: "ready", sources: result.sources })); setCatchup(run); } }).catch(() => { if (!cancelled()) setState((current) => ({ ...current, status: "failed", error: "Memories could not be loaded. Try again." })); }); }, [conversationId]);
	useAsyncEffect((cancelled) => { void loadMemoryAllowance(conversationId).then((settings) => { if (!cancelled()) setMemoryEnabled(settings.enabled); }).catch(() => undefined); }, [conversationId]);
	useEffect(() => { if (editing === null && editButtonRef.current) requestAnimationFrame(() => editButtonRef.current?.focus()); }, [editing]);
	useEffect(() => {
		const interval = window.setInterval(() => { void refresh(); }, 5000);
		return () => window.clearInterval(interval);
	}, [refresh]);
	const retry = async (messageId: number) => {
		setState((current) => ({ ...current, pendingMessageId: messageId, error: null }));
		const result = await resetAndReextract(conversationId, messageId);
		if (result.outcome === "invalid") setState((current) => ({ ...current, pendingMessageId: null, error: result.reason }));
		else { await refresh(); setState((current) => ({ ...current, pendingMessageId: null })); }
	};
	const retryIndex = async (source: State["sources"][number]) => {
		setState((current) => ({ ...current, pendingMessageId: source.messageId, error: null }));
		const result = await retryMemoryIndex(conversationId, source.messageId, source.variantId, source.revision);
		if (result.outcome === "invalid") setState((current) => ({ ...current, pendingMessageId: null, error: result.reason }));
		else { await refresh(); setState((current) => ({ ...current, pendingMessageId: null, error: result.outcome === "conflict" ? "This collection changed elsewhere. Review the current Memory before retrying indexing." : null })); }
	};
	const saveCorrection = async (source: State["sources"][number], index: number) => {
		if (!editing) return;
		setState((current) => ({ ...current, pendingMessageId: source.messageId, error: null }));
		const result = await correctMemory(conversationId, source.messageId, source.variantId, editing.revision, index, "edit", { claim: editing.claim, attribution: editing.attribution, people: editing.people.split(",").map((person) => person.trim()).filter(Boolean) });
		if (result.outcome === "invalid") setState((current) => ({ ...current, pendingMessageId: null, error: result.reason }));
		else { setState((current) => ({ ...current, pendingMessageId: null, error: result.outcome === "conflict" ? "This collection changed elsewhere. Review the current collection before editing again." : null, sources: current.sources.map((item) => item.variantId === result.collection.variantId ? result.collection : item) })); setEditing(null); }
	};
	const removeCorrection = async (source: State["sources"][number], index: number) => {
		setState((current) => ({ ...current, pendingMessageId: source.messageId, error: null }));
		const result = await correctMemory(conversationId, source.messageId, source.variantId, source.revision, index, "remove");
		if (result.outcome === "invalid") setState((current) => ({ ...current, pendingMessageId: null, error: result.reason }));
		else setState((current) => ({ ...current, pendingMessageId: null, error: result.outcome === "conflict" ? "This collection changed elsewhere. Review the current collection before removing anything else." : null, sources: current.sources.map((item) => item.variantId === result.collection.variantId ? result.collection : item) }));
	};
	const beginCatchup = async () => { setCatchupPending(true); setState((current) => ({ ...current, error: null })); try { setCatchup(await startMemoryCatchup(conversationId)); await refresh(); } catch (error) { setState((current) => ({ ...current, error: error instanceof Error ? error.message : "History catch-up could not be started." })); } finally { setCatchupPending(false); } };
	const stopCatchup = async () => { if (!catchup) return; setCatchupPending(true); try { setCatchup(await cancelMemoryCatchup(conversationId, catchup.id)); await refresh(); } catch (error) { setState((current) => ({ ...current, error: error instanceof Error ? error.message : "History catch-up could not be cancelled." })); } finally { setCatchupPending(false); } };
	const selectedSources = state.sources;
	return <aside className="details-panel" data-open="true" aria-label="Memories">
		<PanelHeader title="Memories" onClose={onClose} />
		<div className="panel-body memory-panel-body">
			<p className="panel-note">Memories are source-owned story claims with evidence. Unselected alternatives stay inspectable and remain saved to their source.</p>
			<MemoryAllowanceControl conversationId={conversationId} />
			<section className="memory-catchup"><h3>Existing history</h3><p>Remember current selected history on request. Current results and writer-maintained collections are skipped.</p>{catchup?.state === "running" ? <><p role="status">{catchup.pending} pending · {catchup.running} running · {catchup.complete} complete · {catchup.failed.length} failed</p><Button type="button" size="sm" variant="outline" disabled={catchupPending} onClick={() => void stopCatchup()}>Cancel catch-up</Button></> : <><Button type="button" size="sm" disabled={catchupPending || !memoryEnabled} onClick={() => void beginCatchup()}>Remember existing history</Button>{catchup && <p role="status">Last run: {catchup.state} · {catchup.complete} complete · {catchup.failed.length} failed</p>}</>}{catchup?.failed.map((item) => <p className="import-problem" key={item.messageId}><button type="button" onClick={() => onNavigateSource(item.messageId)}>Message {item.messageId}</button>: {item.error ?? "Memory extraction failed."} <Button type="button" size="sm" variant="outline" onClick={() => void retry(item.messageId)}>Retry</Button></p>)}</section>
			{state.status === "loading" && <p role="status">Loading selected-path Memories…</p>}
			{state.status === "failed" && <div><p className="import-problem" role="alert">{state.error}</p><Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>Try again</Button></div>}
			{state.status === "ready" && selectedSources.length === 0 && <p className="panel-note">There are no nonempty selected sources to process.</p>}
			{state.error && state.status === "ready" && <p className="import-problem" role="alert">{state.error}</p>}
			{selectedSources.map((source) => <section className="memory-source" key={source.variantId}>
				<header className="memory-source-header"><div><h3>Message {source.messageId}</h3><span>{source.selected ? "Selected source" : "Unselected alternative"} · {source.status === "complete" ? `${source.claims.length} ${source.claims.length === 1 ? "Memory" : "Memories"}` : source.status === "unprocessed" ? "Not processed" : source.status === "stale" ? "Source changed" : source.status === "pending" ? "Pending" : source.status === "running" ? "Running" : "Failed"}</span></div><Button type="button" size="sm" variant="outline" disabled={!source.selected || state.pendingMessageId === source.messageId || source.status === "pending" || source.status === "running"} onClick={() => void retry(source.messageId)}><RotateCcw aria-hidden="true" /> {source.ownership === "writer" ? "Reset and re-extract" : "Retry extraction"}</Button></header>
				<p className="panel-note">{source.indexing.status === "ready" ? "Index ready" : source.indexing.status === "pending" ? `${source.indexing.pendingCount} Memories pending indexing` : source.indexing.status === "running" ? `${source.indexing.pendingCount} Memories indexing` : source.indexing.status === "failed" ? `${source.indexing.failedCount} Memories failed indexing` : source.indexing.status === "unconfigured" ? "Embedding settings needed for indexing" : source.indexing.status === "not-applicable" ? source.status === "complete" ? "No saved Memories to index" : "No Memories ready to index" : "Indexing paused"}</p>
				{source.indexing.error && <p className="import-problem" role="alert">{source.indexing.error}</p>}
				{source.indexing.status === "failed" && <Button type="button" size="sm" variant="outline" disabled={state.pendingMessageId === source.messageId} onClick={() => void retryIndex(source)}><RefreshCw aria-hidden="true" /> Retry indexing</Button>}
				<p className="memory-reset-note">{source.ownership === "writer" ? "Reset and re-extract discards every saved correction and resumes automatic updates for this source." : "Retry extraction replaces this source’s automatic collection."}</p>
				<button type="button" className="memory-source-link" onClick={() => onNavigateSource(source.messageId)}>Go to source Message</button>
				{source.error && <p className="import-problem" role="alert">{source.error}</p>}
				{source.status !== "unprocessed" && <MemoryTraceView conversationId={conversationId} variantId={source.variantId} live={source.status === "pending" || source.status === "running"} />}
				{source.status === "complete" && source.claims.length === 0 && <p className="panel-note">{source.ownership === "writer" ? "All Memories were removed. Automatic updates are paused for this source." : "No Memories were found for this source."}</p>}
				{source.claims.map((claim, index) => <article className="memory-claim" key={`${source.variantId}-${index}`}>
					{editing?.messageId === source.messageId && editing.index === index ? <div className="memory-edit-form">
						<label className="field"><span>Memory</span><textarea autoFocus className="field-input" value={editing.claim} onChange={(event) => setEditing({ ...editing, claim: event.target.value })} /></label>
						<label className="field"><span>Attribution</span><input className="field-input" value={editing.attribution} onChange={(event) => setEditing({ ...editing, attribution: event.target.value })} /></label>
						<label className="field"><span>People, separated by commas</span><input className="field-input" value={editing.people} onChange={(event) => setEditing({ ...editing, people: event.target.value })} /></label>
						<Button type="button" size="sm" disabled={state.pendingMessageId === source.messageId} onClick={() => void saveCorrection(source, index)}><Check aria-hidden="true" /> Save</Button><Button type="button" size="sm" variant="outline" onClick={() => setEditing(null)}><X aria-hidden="true" /> Cancel</Button>
					</div> : <><h4>{claim.claim}</h4><p>{claim.attribution}{claim.people.length ? ` · ${claim.people.join(", ")}` : ""}{claim.writerMaintained && " · Writer-maintained"}</p><Button ref={editButtonRef} type="button" size="sm" variant="outline" disabled={state.pendingMessageId === source.messageId} onClick={(event) => { editButtonRef.current = event.currentTarget; setEditing({ messageId: source.messageId, revision: source.revision, index, claim: claim.claim, attribution: claim.attribution, people: claim.people.join(", ") }); }}><Pencil aria-hidden="true" /> Edit</Button><Button type="button" size="sm" variant="outline" disabled={state.pendingMessageId === source.messageId} onClick={() => void removeCorrection(source, index)}><Trash2 aria-hidden="true" /> Remove</Button></>}
					<details><summary>Evidence and judgment</summary>{claim.writerMaintained && <p className="panel-note">Original extraction evidence is provenance for the first wording; it does not prove the corrected text.</p>}<ul>{claim.evidence.map((evidence, evidenceIndex) => <li key={`${evidence.messageId}-${evidenceIndex}`}><button type="button" onClick={() => onNavigateSource(evidence.messageId)}>Message {evidence.messageId}</button><blockquote>{evidence.excerpt}</blockquote></li>)}</ul><p>Jev outputs: support {claim.judgment.support} (confidence {claim.judgment.confidence.support.toFixed(2)}); attribution {claim.judgment.attribution} (confidence {claim.judgment.confidence.attribution.toFixed(2)}); usefulness {claim.judgment.usefulness} (confidence {claim.judgment.confidence.usefulness.toFixed(2)}). Probabilities are model outputs, not proof of truth.</p></details>
				</article>)}
			</section>)}
		</div>
	</aside>;
}

function MemoryAllowanceControl({ conversationId }: { conversationId: number }) {
	const [settings, setSettings] = useState<ConversationMemoryAllowance | null>(null);
	const [value, setValue] = useState("2048");
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	useAsyncEffect((cancelled) => { void loadMemoryAllowance(conversationId).then((loaded) => { if (!cancelled()) { setSettings(loaded); setValue(String(loaded.allowance)); } }).catch(() => { if (!cancelled()) setError("Memory Allowance could not be loaded."); }); }, [conversationId]);
	const save = async () => {
		if (!settings) return;
		setPending(true); setError(null); setNotice(null);
		const result = await saveMemoryAllowance(conversationId, settings.revision, Number(value));
		if (result.outcome === "applied") { setSettings(result.settings); setValue(String(result.settings.allowance)); setNotice("Memory Allowance saved."); }
		else if (result.outcome === "conflict") { setSettings(result.currentSettings); setNotice("Memory Allowance changed elsewhere. Review the current value before saving again."); }
		else setError(result.reason);
		setPending(false);
	};
	return <section className="memory-allowance"><h3>Memory Allowance</h3><p>A ceiling for recalled Memory text in a Generation. Zero keeps remembering enabled and retains saved collections.</p><label className="field"><span>Estimated tokens</span><input className="field-input" type="number" min="0" step="1" value={value} onChange={(event) => setValue(event.target.value)} /></label><Button type="button" size="sm" onClick={() => void save()} disabled={pending || !settings}>Save allowance</Button>{error && <p className="import-problem" role="alert">{error}</p>}{notice && <p className="panel-note" role="status">{notice}</p>}</section>;
}

function MemoryTraceView({ conversationId, variantId, live }: { conversationId: number; variantId: number; live: boolean }) {
	const [open, setOpen] = useState(false);
	const [steps, setSteps] = useState<MemoryTraceStep[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!open) return;
		const load = () => { void loadMemoryTrace(conversationId, variantId).then((loaded) => { setSteps(loaded); setError(null); }).catch(() => setError("Pipeline trace could not be loaded.")); };
		load();
		if (!live) return;
		const interval = window.setInterval(load, 2000);
		return () => window.clearInterval(interval);
	}, [open, live, conversationId, variantId]);
	return <details className="memory-trace" onToggle={(event) => setOpen(event.currentTarget.open)}>
		<summary>Pipeline trace{steps ? ` · ${steps.length} ${steps.length === 1 ? "step" : "steps"}` : ""}{live ? " · live" : ""}</summary>
		{error && <p className="import-problem" role="alert">{error}</p>}
		{steps?.length === 0 && <p className="panel-note">No trace recorded yet. Retry extraction to capture one.</p>}
		<ol>{steps?.map((step, index) => <li key={index}><details open={step.label === "Failed"}>
			<summary><span>{step.label}</span><span>{new Date(step.at).toLocaleTimeString()}{step.fields.elapsed ? ` · ${step.fields.elapsed}` : ""}</span></summary>
			{Object.entries(step.fields).map(([key, value]) => <div className="memory-trace-field" key={key}><span>{key}</span><pre>{value}</pre></div>)}
		</details></li>)}</ol>
	</details>;
}
