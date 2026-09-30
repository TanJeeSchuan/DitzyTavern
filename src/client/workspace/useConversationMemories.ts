import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemorySourceTarget } from "../../shared/contract/memory";
import { cancelMemoryCatchup, correctMemory, loadConversationMemories, loadMemoryAllowance, loadMemoryCatchup, resetAndReextract, retryMemoryIndex, startMemoryCatchup, type ConversationMemories, type ConversationMemoryAllowance, type MemoryCatchup } from "../memories";

type Source = ConversationMemories["sources"][number];
export type ClaimDraft = { claim: string; attribution: string; people: string[] };
const conflictNotice = "This collection changed elsewhere. Review the current Memories before changing them again.";
const targetOf = ({ messageId, variantId, revision }: Source): MemorySourceTarget => ({ messageId, variantId, expectedRevision: revision });
const inFlight = (status: string) => status === "pending" || status === "running";

export function useConversationMemories(conversationId: number) {
	const [status, setStatus] = useState<"loading" | "ready" | "stale" | "failed">("loading");
	const [memories, setMemories] = useState<ConversationMemories | null>(null);
	const [catchup, setCatchup] = useState<MemoryCatchup | null>(null);
	const [allowance, setAllowance] = useState<ConversationMemoryAllowance | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
	const [catchupBusy, setCatchupBusy] = useState(false);
	const [editing, setEditing] = useState<{ variantId: number; revision: number; index: number } | null>(null);
	const [resetTarget, setResetTarget] = useState<Source | null>(null);
	const refresh = useCallback(async () => {
		try {
			const [loaded, run, settings] = await Promise.all([loadConversationMemories(conversationId), loadMemoryCatchup(conversationId), loadMemoryAllowance(conversationId)]);
			setMemories(loaded); setCatchup(run); setAllowance(settings); setStatus("ready");
		} catch { setStatus((current) => current === "loading" || current === "failed" ? "failed" : "stale"); }
	}, [conversationId]);
	const live = catchup?.state === "running" || (memories?.sources.some((source) => inFlight(source.status) || inFlight(source.indexing.status)) ?? false);
	useEffect(() => { void refresh(); }, [refresh]);
	useEffect(() => {
		if (!live) return;
		const interval = window.setInterval(() => void refresh(), 5000);
		return () => window.clearInterval(interval);
	}, [live, refresh]);

	const replace = useCallback((collection: Source) => setMemories((current) => current && { ...current, sources: current.sources.map((item) => item.variantId === collection.variantId ? collection : item) }), []);
	const act = useCallback(async (source: Source, task: () => Promise<string | null>) => {
		setBusy((current) => new Set(current).add(source.variantId)); setNotice(null);
		try { setNotice(await task()); } finally { setBusy((current) => { const next = new Set(current); next.delete(source.variantId); return next; }); }
	}, []);
	const reextract = useCallback((source: Source) => act(source, async () => {
		const result = await resetAndReextract(conversationId, targetOf(source));
		if (result.outcome === "invalid") return result.reason;
		if (result.outcome === "conflict") { replace(result.collection); return conflictNotice; }
		await refresh();
		return null;
	}), [act, conversationId, refresh, replace]);
	const catchupAction = async (task: () => ReturnType<typeof startMemoryCatchup | typeof cancelMemoryCatchup>) => {
		setCatchupBusy(true); setNotice(null);
		try {
			const result = await task();
			if (result.outcome === "invalid") setNotice(result.reason); else { setCatchup(result.run); await refresh(); }
		} catch { setNotice("History catch-up could not be changed."); } finally { setCatchupBusy(false); }
	};
	const actions = useMemo(() => ({
		label: (messageId: number) => {
			const index = memories?.path.findIndex((entry) => entry.messageId === messageId) ?? -1;
			return index < 0 ? "Earlier Message" : `${memories?.path[index]?.author ?? "Unknown author"} · #${index + 1}`;
		},
		retry: (source: Source) => { if (source.ownership === "writer") setResetTarget(source); else void reextract(source); },
		retryIndex: (source: Source) => void act(source, async () => {
			const result = await retryMemoryIndex(conversationId, targetOf(source));
			if (result.outcome === "invalid") return result.reason;
			await refresh();
			return result.outcome === "conflict" ? conflictNotice : null;
		}),
		edit: (source: Source, index: number | null) => setEditing(index === null ? null : { variantId: source.variantId, revision: source.revision, index }),
		save: (source: Source, index: number, draft: ClaimDraft) => { if (editing?.variantId !== source.variantId || editing.index !== index) return; void act(source, async () => {
			const result = await correctMemory(conversationId, { ...targetOf(source), expectedRevision: editing.revision, index, operation: "edit", ...draft });
			if (result.outcome === "invalid") return result.reason;
			replace(result.collection); setEditing(null);
			return result.outcome === "conflict" ? conflictNotice : null;
		}); },
		remove: (source: Source, index: number) => void act(source, async () => {
			const result = await correctMemory(conversationId, { ...targetOf(source), index, operation: "remove" });
			if (result.outcome === "invalid") return result.reason;
			replace(result.collection);
			return result.outcome === "conflict" ? conflictNotice : null;
		}),
	}), [act, conversationId, editing, memories, reextract, refresh, replace]);

	return {
		status, memories, catchup, allowance, notice, busy, catchupBusy, editing, resetTarget, actions, refresh, setAllowance,
		startCatchup: () => catchupAction(() => startMemoryCatchup(conversationId)),
		cancelCatchup: () => catchup && catchupAction(() => cancelMemoryCatchup(conversationId, catchup.id)),
		confirmReset: () => { if (resetTarget) void reextract(resetTarget); setResetTarget(null); },
		cancelReset: () => setResetTarget(null),
		labelsMerged: (updated: ConversationMemories, destination: string) => { setMemories(updated); setEditing(null); setNotice(`Labels merged into ${destination}.`); },
	};
}

export type ConversationMemoryActions = ReturnType<typeof useConversationMemories>["actions"];
