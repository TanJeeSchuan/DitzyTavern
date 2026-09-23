import { RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { loadConversationMemories, loadMemoryAllowance, resetAndReextract, saveMemoryAllowance, type ConversationMemoryAllowance } from "../memories";
import { PanelHeader } from "../PanelHeader";
import { useAsyncEffect } from "../lib/use-async";

type State = { status: "loading" | "ready" | "failed"; sources: Awaited<ReturnType<typeof loadConversationMemories>>["sources"]; error: string | null; pendingMessageId: number | null };

export function MemoriesPanel({ conversationId, onClose, onNavigateSource }: { conversationId: number; onClose: () => void; onNavigateSource: (messageId: number) => void }) {
	const [state, setState] = useState<State>({ status: "loading", sources: [], error: null, pendingMessageId: null });
	const refresh = useCallback(async () => {
		try { const result = await loadConversationMemories(conversationId); setState((current) => ({ ...current, status: "ready", sources: result.sources, error: null })); }
		catch { setState((current) => ({ ...current, status: "failed", error: "Memories could not be loaded. Try again." })); }
	}, [conversationId]);
	useAsyncEffect((cancelled) => { void loadConversationMemories(conversationId).then((result) => { if (!cancelled()) setState((current) => ({ ...current, status: "ready", sources: result.sources })); }).catch(() => { if (!cancelled()) setState((current) => ({ ...current, status: "failed", error: "Memories could not be loaded. Try again." })); }); }, [conversationId]);
	useEffect(() => {
		if (!state.sources.some((source) => source.status === "pending" || source.status === "running")) return;
		const interval = window.setInterval(() => { void refresh(); }, 1200);
		return () => window.clearInterval(interval);
	}, [state.sources, refresh]);
	const retry = async (messageId: number) => {
		setState((current) => ({ ...current, pendingMessageId: messageId, error: null }));
		const result = await resetAndReextract(conversationId, messageId);
		if (result.outcome === "invalid") setState((current) => ({ ...current, pendingMessageId: null, error: result.reason }));
		else { await refresh(); setState((current) => ({ ...current, pendingMessageId: null })); }
	};
	const selectedSources = state.sources;
	return <aside className="details-panel" data-open="true" aria-label="Memories">
		<PanelHeader title="Memories" onClose={onClose} />
		<div className="panel-body memory-panel-body">
			<p className="panel-note">Memories are selected story claims with source evidence. They are not yet indexed for Generation recall.</p>
			<MemoryAllowanceControl conversationId={conversationId} />
			{state.status === "loading" && <p role="status">Loading selected-path Memories…</p>}
			{state.status === "failed" && <div><p className="import-problem" role="alert">{state.error}</p><Button type="button" size="sm" variant="outline" onClick={() => void refresh()}>Try again</Button></div>}
			{state.status === "ready" && selectedSources.length === 0 && <p className="panel-note">There are no nonempty selected sources to process.</p>}
			{state.error && state.status === "ready" && <p className="import-problem" role="alert">{state.error}</p>}
			{selectedSources.map((source) => <section className="memory-source" key={source.variantId}>
				<header className="memory-source-header"><div><h3>Message {source.messageId}</h3><span>{source.status === "complete" ? `${source.claims.length} ${source.claims.length === 1 ? "Memory" : "Memories"}` : source.status === "unprocessed" ? "Not processed" : source.status === "stale" ? "Source changed" : source.status === "pending" ? "Pending" : source.status === "running" ? "Running" : "Failed"}</span></div><Button type="button" size="sm" variant="outline" disabled={state.pendingMessageId === source.messageId || source.status === "pending" || source.status === "running"} onClick={() => void retry(source.messageId)}><RotateCcw aria-hidden="true" /> Reset and re-extract</Button></header>
				<p className="memory-reset-note">This replaces this source’s collection and clears its saved corrections.</p>
				<button type="button" className="memory-source-link" onClick={() => onNavigateSource(source.messageId)}>Go to source Message</button>
				{source.error && <p className="import-problem" role="alert">{source.error}</p>}
				{source.status === "complete" && source.claims.length === 0 && <p className="panel-note">No Memories were found for this source.</p>}
				{source.claims.map((claim, index) => <article className="memory-claim" key={`${source.variantId}-${index}`}><h4>{claim.claim}</h4><p>{claim.attribution}{claim.people.length ? ` · ${claim.people.join(", ")}` : ""}</p><details><summary>Evidence and judgment</summary><ul>{claim.evidence.map((evidence, evidenceIndex) => <li key={`${evidence.messageId}-${evidenceIndex}`}><button type="button" onClick={() => onNavigateSource(evidence.messageId)}>Message {evidence.messageId}</button><blockquote>{evidence.excerpt}</blockquote></li>)}</ul><p>Jev outputs: support {claim.judgment.support}; usefulness {claim.judgment.usefulness}. Probabilities are model outputs, not proof of truth.</p></details></article>)}
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
