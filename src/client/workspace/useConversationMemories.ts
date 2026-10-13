import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import { cancelBoxCatchUp, digestBoxPassage, startBoxCatchUp, type BoxDigest } from "../box-digest";
import { loadConversationMemories, loadMemoryAllowance, type ConversationMemories, type ConversationMemoryAllowance } from "../memories";
import { labelledMemories, type MemoryClaim } from "./memories-view";

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
const changedNotice = "This Message's Memories changed while you looked at them. Review them before changing them again.";
const sameClaim = (left: MemoryClaim) => (right: MemoryClaim) => JSON.stringify(left) === JSON.stringify(right);

// @approved
//  The panel's Memory work. A claim edit or removal writes the passage's whole
//  claims list as its Writer record, and reset drops that record so the
//  automatic claims return; both are Conversation commands. Each acts on the
//  stored claim, not its labelled display, found again in the current list,
//  since a digest landing meanwhile changes no Conversation revision.
//  Remembering a passage and catch-up queue host digests, whose records the
//  polled read picks up.
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
	const [editing, setEditing] = useState<{ variantId: number; index: number; claim: MemoryClaim } | null>(null);
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
	const writeClaim = (source: Source, target: MemoryClaim, change: (claim: MemoryClaim) => MemoryClaim[]) => act(source, async () => {
		const claims = storedClaims(source);
		const position = claims.findIndex(sameClaim(target));
		if (position === -1) { setNotice(changedNotice); return false; }
		return runConversationCommand(surface, { type: "set-box-record", box: "memory", messageId: source.messageId, variantId: source.variantId, record: { claims: claims.flatMap((claim, index) => index === position ? change(claim) : [claim]) } }, options);
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
			const claim = index === null ? undefined : storedClaims(source)[index];
			setEditing(index === null || claim === undefined ? null : { variantId: source.variantId, index, claim });
		},
		save: (source: Source, draft: ClaimDraft) => {
			if (editing?.variantId === source.variantId) void writeClaim(source, editing.claim, (claim) => [{ ...claim, ...draft, writerMaintained: true }]).then((applied) => { if (applied) setEditing(null); });
		},
		remove: (source: Source, index: number) => {
			const claim = storedClaims(source)[index];
			if (claim !== undefined) void writeClaim(source, claim, () => []);
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
