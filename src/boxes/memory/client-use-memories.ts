import { type ConversationSummary, CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand, cancelBoxCatchUp, digestBoxPassage, startBoxCatchUp, type BoxDigest } from "@/box-sdk/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadConversationMemories, loadMemoryAllowance } from "./client-api";
import { type ConversationMemories, type ConversationMemoryAllowance } from "./contract";
import { labelledMemories, type MemoryClaim } from "./client-view";

type Source = ConversationMemories["sources"][number];
type MemoryData = { memories: ConversationMemories; settings: ConversationMemoryAllowance };
export type ClaimDraft = { claim: string; attribution: string; people: string[] };

/** @approved The Chat's Memories, labelled for display. `poll` keeps an open panel current while digests land, faster during catch-up. */
export function useConversationMemories(conversationId: number, conversationRevision: number, { poll = false } = {}) {
	const client = useQueryClient();
	const queryKey = useMemo(() => ["memories", conversationId] as const, [conversationId]);
	const query = useQuery({
		queryKey,
		queryFn: async ({ signal }): Promise<MemoryData> => {
			const [memories, settings] = await Promise.all([loadConversationMemories(conversationId, signal), loadMemoryAllowance(conversationId, signal)]);
			return { memories, settings };
		},
		refetchInterval: (current) => !poll ? false : current.state.data?.memories.catchUp == null ? 2_500 : 750,
		refetchIntervalInBackground: false,
	});
	const refresh = useCallback(() => client.invalidateQueries({ queryKey }), [client, queryKey]);
	useEffect(() => { void refresh(); }, [conversationRevision, refresh]);
	const update = useCallback(async (change: (current: MemoryData) => MemoryData) => {
		await client.cancelQueries({ queryKey });
		client.setQueryData<MemoryData>(queryKey, (current) => current && change(current));
	}, [client, queryKey]);
	const stored = query.data?.memories ?? null;
	const memories = useMemo(() => stored && labelledMemories(stored), [stored]);
	return {
		status: query.isPending ? "loading" : query.isError ? query.data === undefined ? "failed" : "stale" : "ready",
		memories,
		stored,
		settings: query.data?.settings ?? null,
		refresh,
		settingsSaved: (saved: ConversationMemoryAllowance) => update((current) => ({ ...current, settings: saved })),
		identitySaved: async (updated: ConversationMemories) => {
			await update((current) => ({ ...current, memories: updated }));
			await refresh();
		},
		labelsMerged: (updated: ConversationMemories) => update((current) => ({ ...current, memories: updated })),
	};
}

const conflictNotice = "The Chat changed elsewhere. Review the current Memories before changing them again.";

// @approved
//  The panel's Memory work. A claim edit or removal writes the passage's whole
//  claims list as its Writer record, and reset drops that record so the
//  automatic claims return; both are Conversation commands. An edit or
//  removal changes the stored claims it read, not their labelled display, and
//  names them as `expected`, so the host refuses it when a digest replaced
//  them meanwhile. Remembering a passage and catch-up queue host digests,
//  whose records the polled read picks up.
export function useMemoryActions({ conversationId, conversation, onConversationChange, stored, refresh }: {
	conversationId: number;
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
	stored: ConversationMemories | null;
	refresh: () => Promise<void>;
}) {
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
	const [catchupBusy, setCatchupBusy] = useState(false);
	const [editing, setEditing] = useState<{ variantId: number; index: number; claims: MemoryClaim[] } | null>(null);
	const [resetTarget, setResetTarget] = useState<Source | null>(null);
	const act = async (source: Source, task: () => Promise<boolean>) => {
		setBusy((current) => new Set(current).add(source.variantId)); setNotice(null);
		try { return await task(); }
		catch { setNotice(CONVERSATION_UNREACHABLE_NOTICE); return false; }
		finally { setBusy((current) => { const next = new Set(current); next.delete(source.variantId); return next; }); }
	};
	const surface = { conversationId, revision: () => conversation.revision, onConversationChange, setNotice };
	const options = { notices: { conflict: conflictNotice }, onApplied: () => void refresh() };
	const storedClaims = (source: Source) => stored?.sources.find(({ variantId }) => variantId === source.variantId)?.claims ?? [];
	const writeClaims = (source: Source, read: MemoryClaim[], claims: MemoryClaim[]) => act(source, async () => {
		const applied = await runConversationCommand(surface, { type: "set-box-record", box: "memory", messageId: source.messageId, variantId: source.variantId, record: { claims }, expected: { claims: read } }, options);
		if (!applied) void refresh();
		return applied;
	});
	const queued = async (read: Promise<BoxDigest | null>) => {
		if (await read === null) setNotice(CONVERSATION_UNREACHABLE_NOTICE);
		await refresh();
		return true;
	};
	const catchUp = async (task: () => Promise<BoxDigest | null>) => {
		setCatchupBusy(true); setNotice(null);
		try { await queued(task()); } catch { setNotice(CONVERSATION_UNREACHABLE_NOTICE); } finally { setCatchupBusy(false); }
	};
	return {
		notice, busy, catchupBusy, editing, resetTarget,
		remember: (source: Source) => void act(source, () => queued(digestBoxPassage(conversationId, "memory", source.variantId))),
		edit: (source: Source, index: number | null) => {
			const claims = storedClaims(source);
			setEditing(index === null || claims[index] === undefined ? null : { variantId: source.variantId, index, claims });
		},
		save: (source: Source, draft: ClaimDraft) => {
			if (editing?.variantId !== source.variantId) return;
			const { index, claims } = editing;
			void writeClaims(source, claims, claims.map((claim, position) => position === index ? { ...claim, ...draft, writerMaintained: true } : claim)).then((applied) => { if (applied) setEditing(null); });
		},
		remove: (source: Source, index: number) => {
			const claims = storedClaims(source);
			void writeClaims(source, claims, claims.filter((_, position) => position !== index));
		},
		requestReset: (source: Source) => setResetTarget(source),
		confirmReset: () => {
			if (resetTarget) void act(resetTarget, () => runConversationCommand(surface, { type: "reset-box-record", box: "memory", messageId: resetTarget.messageId, variantId: resetTarget.variantId }, options));
			setResetTarget(null);
		},
		cancelReset: () => setResetTarget(null),
		announce: setNotice,
		startCatchup: () => catchUp(() => startBoxCatchUp(conversationId, "memory")),
		cancelCatchup: () => catchUp(() => cancelBoxCatchUp(conversationId, "memory")),
	};
}
