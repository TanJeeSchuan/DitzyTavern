import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { MemorySourceTarget } from "../../shared/contract/memory";
import { cancelMemoryCatchup, correctMemory, loadConversationMemories, loadMemoryAllowance, loadMemoryCatchup, loadMemoryChanges, resetAndReextract, retryMemoryIndex, startMemoryCatchup, type ConversationMemories, type ConversationMemoryAllowance, type MemoryCatchup } from "../memories";

type Source = ConversationMemories["sources"][number];
type MemoryData = { memories: ConversationMemories; catchup: MemoryCatchup | null; settings: ConversationMemoryAllowance };
export type ClaimDraft = { claim: string; attribution: string; people: string[] };
const conflictNotice = "This collection changed elsewhere. Review the current Memories before changing them again.";
const targetOf = ({ messageId, variantId, revision }: Source): MemorySourceTarget => ({ messageId, variantId, expectedRevision: revision });
const inFlight = (status: string) => status === "pending" || status === "running";
const workInFlight = (data: MemoryData | undefined) => data !== undefined && (data.catchup?.state === "running" || data.memories.sources.some((source) => inFlight(source.status) || inFlight(source.indexing.status)));

export function useConversationMemories(conversationId: number, conversationRevision: number) {
	const client = useQueryClient();
	const queryKey = useMemo(() => ["memories", conversationId] as const, [conversationId]);
	const query = useQuery({
		queryKey,
		queryFn: async ({ signal }) => {
			const [memories, catchup, settings] = await Promise.all([loadConversationMemories(conversationId, signal), loadMemoryCatchup(conversationId, signal), loadMemoryAllowance(conversationId, signal)]);
			return { memories, catchup, settings };
		},
	});
	const refresh = useCallback(() => client.invalidateQueries({ queryKey }), [client, queryKey]);
	useQuery({
		queryKey: ["memory-changes", conversationId],
		enabled: workInFlight(query.data),
		refetchInterval: 5000,
		queryFn: async ({ signal }) => {
			const cached = client.getQueryData<MemoryData>(queryKey);
			if (!cached) return null;
			const since = cached.memories.cursor;
			const [changes, catchup] = await Promise.all([
				loadMemoryChanges(conversationId, since, signal),
				cached.catchup?.state === "running" ? loadMemoryCatchup(conversationId, signal) : cached.catchup,
			]);
			const current = client.getQueryData<MemoryData>(queryKey);
			if (current?.memories.cursor !== since) return null;
			if (changes.revision !== current.memories.revision || changes.labelRevision !== current.memories.labelRevision) { await refresh(); return null; }
			const sources = [...new Map([...current.memories.sources, ...changes.sources].map((source) => [source.variantId, source])).values()];
			client.setQueryData<MemoryData>(queryKey, { ...current, catchup, memories: { ...current.memories, cursor: changes.cursor, sources } });
			return null;
		},
	});
	const memories = query.data?.memories ?? null;
	const catchup = query.data?.catchup ?? null;
	const settings = query.data?.settings ?? null;
	const status = query.isPending ? "loading" : query.isError ? query.data === undefined ? "failed" : "stale" : "ready";
	useEffect(() => { void refresh(); }, [conversationRevision, refresh]);
	const update = useCallback(async (change: (current: MemoryData) => MemoryData) => {
		await client.cancelQueries({ queryKey });
		client.setQueryData<MemoryData>(queryKey, (current) => current && change(current));
	}, [client, queryKey]);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
	const [catchupBusy, setCatchupBusy] = useState(false);
	const [editing, setEditing] = useState<{ variantId: number; revision: number; index: number } | null>(null);
	const [resetTarget, setResetTarget] = useState<Source | null>(null);
	const replace = useCallback((collection: Source) => update((current) => ({
		...current,
		memories: { ...current.memories, sources: current.memories.sources.map((item) => item.variantId === collection.variantId && item.revision <= collection.revision ? collection : item) },
	})), [update]);
	const act = useCallback(async (source: Source, task: () => Promise<string | null>) => {
		setBusy((current) => new Set(current).add(source.variantId)); setNotice(null);
		try { setNotice(await task()); } finally { setBusy((current) => { const next = new Set(current); next.delete(source.variantId); return next; }); }
	}, []);
	const reextract = useCallback((source: Source) => act(source, async () => {
		const result = await resetAndReextract(conversationId, targetOf(source));
		if (result.outcome === "invalid") return result.reason;
		await replace(result.collection);
		await refresh();
		return result.outcome === "conflict" ? conflictNotice : null;
	}), [act, conversationId, refresh, replace]);
	const catchupAction = async (task: () => ReturnType<typeof startMemoryCatchup | typeof cancelMemoryCatchup>) => {
		setCatchupBusy(true); setNotice(null);
		try {
			const result = await task();
			if (result.outcome === "invalid") setNotice(result.reason); else { await update((current) => ({ ...current, catchup: result.run })); await refresh(); }
		} catch { setNotice("History catch-up could not be changed."); } finally { setCatchupBusy(false); }
	};
	const labels = useMemo(() => new Map(memories?.path.map((entry, index) => [entry.messageId, `${entry.author ?? "Unknown author"} · #${index + 1}`])), [memories?.path]);
	const actions = useMemo(() => ({
		label: (messageId: number) => labels.get(messageId) ?? "Earlier Message",
		retry: (source: Source) => { if (source.ownership === "writer") setResetTarget(source); else void reextract(source); },
		retryIndex: (source: Source) => void act(source, async () => {
			const result = await retryMemoryIndex(conversationId, targetOf(source));
			if (result.outcome === "invalid") return result.reason;
			await replace(result.collection);
			await refresh();
			return result.outcome === "conflict" ? conflictNotice : null;
		}),
		edit: (source: Source, index: number | null) => setEditing(index === null ? null : { variantId: source.variantId, revision: source.revision, index }),
		save: (source: Source, index: number, draft: ClaimDraft) => { if (editing?.variantId !== source.variantId || editing.index !== index) return; void act(source, async () => {
			const result = await correctMemory(conversationId, { ...targetOf(source), expectedRevision: editing.revision, index, operation: "edit", ...draft });
			if (result.outcome === "invalid") return result.reason;
			await replace(result.collection); setEditing(null);
			return result.outcome === "conflict" ? conflictNotice : null;
		}); },
		remove: (source: Source, index: number) => void act(source, async () => {
			const result = await correctMemory(conversationId, { ...targetOf(source), index, operation: "remove" });
			if (result.outcome === "invalid") return result.reason;
			await replace(result.collection);
			return result.outcome === "conflict" ? conflictNotice : null;
		}),
	}), [act, conversationId, editing, labels, reextract, refresh, replace]);

	return {
		status, memories, catchup, settings, notice, busy, catchupBusy, editing, resetTarget, actions, refresh,
		settingsSaved: (saved: ConversationMemoryAllowance) => update((current) => ({ ...current, settings: saved })),
		startCatchup: () => catchupAction(() => startMemoryCatchup(conversationId)),
		cancelCatchup: () => catchup && catchupAction(() => cancelMemoryCatchup(conversationId, catchup.id)),
		confirmReset: () => { if (resetTarget) void reextract(resetTarget); setResetTarget(null); },
		cancelReset: () => setResetTarget(null),
		identitySaved: async (updated: ConversationMemories) => { await update((current) => ({ ...current, memories: updated })); setEditing(null); setNotice(null); await refresh(); },
		labelsMerged: async (updated: ConversationMemories, destination: string) => { await update((current) => ({ ...current, memories: updated })); setEditing(null); setNotice(`Labels merged into ${destination}.`); },
	};
}

export type ConversationMemoryActions = ReturnType<typeof useConversationMemories>["actions"];
