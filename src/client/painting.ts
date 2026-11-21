import { createContext, useEffect, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Type } from "@sinclair/typebox";
import { decodeWirePayload } from "./lib/wire-decode";
import { api } from "./lib/eden";
import { requestData } from "./lib/request-outcome";
import { requestOutcome } from "./lib/request-route-outcome";
import { illustrationsResponse, galleryResponse, paintingCommandResponse, type PaintingCommand, type IllustrationsRead } from "../shared/contract/painting";
import type { ReferenceSet } from "../shared/contract/reference-set";
import { conversationKey, publishConversation } from "./conversation-query";
import type { ConversationSummary } from "./conversation";
import { followsChanges } from "./server-changes";

export const illustrationsKey = (conversationId: number | null) => ["illustrations", conversationId] as const;
export const useIllustrations = (conversationId: number | null, variantId?: number) => useQuery({
	queryKey: illustrationsKey(conversationId), enabled: conversationId !== null, meta: followsChanges, refetchOnMount: variantId === undefined,
	select: (read: IllustrationsRead) => variantId === undefined ? read : { ...read, paintings: read.paintings.filter((painting) => painting.variantId === variantId) },
	queryFn: () => {
		if (conversationId === null) throw new Error("No Chat selected.");
		return requestData(api.api.conversations({ id: conversationId }).illustrations.get(), illustrationsResponse[200]);
	},
});
export const useGallery = (conversationId: number) => useQuery({
	queryKey: ["gallery", conversationId], meta: followsChanges,
	queryFn: () => requestData(api.api.conversations({ id: conversationId }).gallery.get(), galleryResponse[200]),
});

const commandPainting = async (client: QueryClient, conversationId: number, command: PaintingCommand) => {
	const result = await requestOutcome(api.api.conversations({ id: conversationId }).illustrations.commands.post(command), paintingCommandResponse);
	if (result.outcome === "available" && result.value.referenceRevision !== undefined) {
		const { before, after } = result.value.referenceRevision;
		const saves = savesOf(conversationId);
		saves.revision = { before: saves.revision?.after === before ? saves.revision.before : before, after };
		const summary = client.getQueryData<ConversationSummary>(conversationKey(conversationId));
		if (summary?.revision === before) publishConversation(client, { ...summary, revision: after });
	}
	return result;
};

export function usePaintingCommand(conversationId: number) {
	const client = useQueryClient();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async (command: PaintingCommand) => {
		setPending(true);
		setError(null);
		try {
			const result = await commandPainting(client, conversationId, command);
			if (result.outcome === "available") await client.invalidateQueries({ queryKey: illustrationsKey(conversationId) });
			else setError(result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "The painting could not be updated. Try again.");
			return result.outcome === "available";
		} finally { setPending(false); }
	};
	return { submit, pending, error };
}

export type PaintTarget = { variantId: number; brief: string; ask: string; requestId: string };

type ReferenceSaves = {
	pending: ReadonlyMap<string, string>;
	locked: boolean;
	timer?: ReturnType<typeof setTimeout>;
	saving: Promise<string | null>;
	listeners: Set<() => void>;
	revision?: { before: number; after: number };
};
const referenceSaves = new Map<number, ReferenceSaves>();
const referenceDraftKey = (conversationId: number) => `ditzy:reference-draft:${conversationId}`;
const referenceDraft = Type.Record(Type.String(), Type.String());
const readReferenceDraft = (conversationId: number) => {
	const stored = window.localStorage?.getItem(referenceDraftKey(conversationId));
	if (stored == null) return new Map<string, string>();
	try { return new Map(Object.entries(decodeWirePayload(referenceDraft, JSON.parse(stored)) ?? {})); }
	catch { return new Map<string, string>(); }
};
const savesOf = (conversationId: number) => {
	const saves: ReferenceSaves = referenceSaves.get(conversationId) ?? { pending: readReferenceDraft(conversationId), locked: false, saving: Promise.resolve(null), listeners: new Set() };
	referenceSaves.set(conversationId, saves);
	return saves;
};
const notify = (saves: ReferenceSaves) => { for (const listener of saves.listeners) listener(); };
const exclusively = async <Result>(conversationId: number, action: () => Promise<Result>) => {
	const saves = savesOf(conversationId);
	if (saves.locked) return false;
	saves.locked = true;
	notify(saves);
	try { return await action(); } finally {
		saves.locked = false;
		notify(saves);
	}
};
const setPending = (conversationId: number, id: string, references: string, saved = false) => {
	const saves = savesOf(conversationId);
	const pending = new Map(saves.pending);
	if (saved) pending.delete(id);
	else pending.set(id, references);
	const stored = readReferenceDraft(conversationId);
	if (!saved) stored.set(id, references);
	else if (stored.get(id) === references) stored.delete(id);
	if (stored.size === 0) window.localStorage?.removeItem(referenceDraftKey(conversationId));
	else window.localStorage?.setItem(referenceDraftKey(conversationId), JSON.stringify(Object.fromEntries(stored)));
	saves.pending = pending;
	notify(saves);
};

const flushReferences = (client: QueryClient, conversationId: number): Promise<string | null> => {
	const saves = savesOf(conversationId);
	clearTimeout(saves.timer);
	saves.saving = saves.saving.then(async () => {
		for (let next = saves.pending.entries().next(); !next.done; next = saves.pending.entries().next()) {
			const [id, references] = next.value;
			const result = await commandPainting(client, conversationId, { type: "save-reference-set", id, references });
			if (result.outcome !== "available") return result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "The References could not be saved.";
			await client.cancelQueries({ queryKey: illustrationsKey(conversationId) });
			client.setQueryData<IllustrationsRead>(illustrationsKey(conversationId), (read) => read && { ...read, referenceSets: read.referenceSets.map((set) => set.id === id ? { ...set, references } : set) });
			if (saves.pending.get(id) === references) setPending(conversationId, id, references, true);
			await client.invalidateQueries({ queryKey: illustrationsKey(conversationId) });
		}
		return null;
	});
	return saves.saving;
};

export async function forkWithSavedReferences(client: QueryClient, conversationId: number, revision: number | null, fork: (revision: number | null) => Promise<string | null>) {
	const result = await exclusively(conversationId, async () => {
		const failure = await flushReferences(client, conversationId);
		if (failure !== null) return failure;
		const writes = savesOf(conversationId).revision;
		return fork(writes !== undefined && revision !== null && revision >= writes.before && revision < writes.after ? writes.after : revision);
	});
	return result === false ? "Wait for References to finish updating before forking." : result;
}

export function useReferenceDraft(conversationId: number, selected: ReferenceSet | undefined) {
	const client = useQueryClient();
	const saves = savesOf(conversationId);
	const subscribe = (listener: () => void) => {
		saves.listeners.add(listener);
		return () => { saves.listeners.delete(listener); };
	};
	const pending = useSyncExternalStore(subscribe, () => saves.pending);
	const locked = useSyncExternalStore(subscribe, () => saves.locked);
	const [error, setError] = useState<string | null>(null);
	const flush = async () => {
		const failure = await flushReferences(client, conversationId);
		setError(failure);
		return failure === null;
	};
	useEffect(() => {
		if (saves.pending.size > 0) void flush();
		return () => void flushReferences(client, conversationId);
	}, [client, conversationId]);
	return {
		references: (selected && pending.get(selected.id)) ?? selected?.references ?? "",
		error,
		locked,
		edit: (references: string) => {
			if (selected === undefined || saves.locked) return;
			setError(null);
			setPending(conversationId, selected.id, references);
			clearTimeout(saves.timer);
			saves.timer = setTimeout(() => void flush(), 600);
		},
		flush,
		exclusively: (action: () => Promise<boolean>) => exclusively(conversationId, action),
	};
}

export function useAdoptReferences(conversationId: number) {
	const client = useQueryClient();
	const { submit, error } = usePaintingCommand(conversationId);
	const [saveError, setSaveError] = useState<string | null>(null);
	const adopt = async (name: string, references: string) => {
		return exclusively(conversationId, async () => {
			if (!references.trim()) return true;
			const failure = await flushReferences(client, conversationId);
			setSaveError(failure);
			if (failure !== null || !await submit({ type: "adopt-reference-set", name, references })) return false;
			const read = client.getQueryData<IllustrationsRead>(illustrationsKey(conversationId));
			if (read?.referenceSets.find(({ id }) => id === read.referenceSetId)?.references === references) return true;
			setSaveError("The References could not be loaded. Try again.");
			return false;
		});
	};
	return { adopt, error: saveError ?? error };
}

export const IllustrationActionsContext = createContext<{
	addToComposer: ((name: string, hash: string) => void) | null;
	editBrief: ((variantId: number, brief: string, ask: string) => void) | null;
	editBriefDisabledReason: string | undefined;
} | null>(null);
