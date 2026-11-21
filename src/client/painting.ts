import { createContext, useEffect, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { decodeWirePayload } from "./lib/wire-decode";
import { api } from "./lib/eden";
import { requestData } from "./lib/request-outcome";
import { requestOutcome } from "./lib/request-route-outcome";
import { illustrationsResponse, galleryResponse, paintingCommandResponse, type PaintingCommand, type IllustrationsRead } from "../shared/contract/painting";
import { referenceDraft, referenceSetCommand, type ReferenceDraftText, type ReferenceSet, type ReferenceSetSelection } from "../shared/contract/reference-set";
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

const commandPainting = (conversationId: number, command: PaintingCommand) =>
	requestOutcome(api.api.conversations({ id: conversationId }).illustrations.commands.post(command), paintingCommandResponse);

const publishReferenceSelection = async (client: QueryClient, conversationId: number, selection: ReferenceSetSelection) => {
	const queryKey = illustrationsKey(conversationId);
	await client.cancelQueries({ queryKey });
	const updated = client.setQueryData<IllustrationsRead>(queryKey, (read) => read && { ...read, ...selection });
	if (updated === undefined) await client.invalidateQueries({ queryKey });
};

export function usePaintingCommand(conversationId: number) {
	const client = useQueryClient();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async (command: Exclude<PaintingCommand, { type: "save-reference-set" }>) => {
		setPending(true);
		setError(null);
		try {
			const result = await commandPainting(conversationId, command);
			if (result.outcome !== "available") {
				setError(result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "The painting could not be updated. Try again.");
				return false;
			}
			if (result.value.outcome === "references-updated") await publishReferenceSelection(client, conversationId, result.value.selection);
			else if (decodeWirePayload(referenceSetCommand, command) !== null) {
				setError("The Reference Set change could not be confirmed.");
				return false;
			} else await client.invalidateQueries({ queryKey: illustrationsKey(conversationId) });
			return true;
		} finally { setPending(false); }
	};
	return { submit, pending, error };
}

export type PaintTarget = { variantId: number; brief: string; ask: string; requestId: string };

type ReferenceSaves = {
	pending: ReadonlyMap<string, ReferenceDraftText>;
	locked: boolean;
	timer?: ReturnType<typeof setTimeout>;
	saving: Promise<string | null>;
	listeners: Set<() => void>;
	conflict?: ReferenceSet;
	storageUnavailable: boolean;
};

const referenceSaves = new Map<number, ReferenceSaves>();
const referenceDraftKey = (conversationId: number) => `ditzy:reference-draft:${conversationId}`;
const readReferenceDraft = (conversationId: number) => {
	try {
		const stored = window.localStorage?.getItem(referenceDraftKey(conversationId));
		return new Map(Object.entries(stored == null ? {} : decodeWirePayload(referenceDraft, JSON.parse(stored)) ?? {}));
	} catch { return new Map<string, ReferenceDraftText>(); }
};
const savesOf = (conversationId: number) => {
	const saves: ReferenceSaves = referenceSaves.get(conversationId) ?? {
		pending: readReferenceDraft(conversationId), locked: false, saving: Promise.resolve(null), listeners: new Set(), storageUnavailable: false,
	};
	referenceSaves.set(conversationId, saves);
	return saves;
};
const notify = (saves: ReferenceSaves) => { for (const listener of saves.listeners) listener(); };
const subscribeTo = (saves: ReferenceSaves) => (listener: () => void) => {
	saves.listeners.add(listener);
	return () => { saves.listeners.delete(listener); };
};

export function useReferenceSetLocked(conversationId: number) {
	const saves = savesOf(conversationId);
	return useSyncExternalStore(subscribeTo(saves), () => saves.locked);
}

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

const sameDraft = (first: ReferenceDraftText | undefined, second: ReferenceDraftText | undefined) => first?.base === second?.base && first?.references === second?.references;

const updatePending = (conversationId: number, id: string, next: ReferenceDraftText | undefined, edited = false) => {
	const saves = savesOf(conversationId);
	const previous = saves.pending.get(id);
	const pending = new Map(saves.pending);
	if (next === undefined) pending.delete(id);
	else pending.set(id, next);
	saves.pending = pending;
	try {
		const stored = readReferenceDraft(conversationId);
		if (edited || sameDraft(stored.get(id), previous)) {
			if (next === undefined) stored.delete(id);
			else stored.set(id, next);
			if (stored.size === 0) window.localStorage?.removeItem(referenceDraftKey(conversationId));
			else window.localStorage?.setItem(referenceDraftKey(conversationId), JSON.stringify(Object.fromEntries(stored)));
			saves.storageUnavailable = false;
		}
	} catch { saves.storageUnavailable = pending.size > 0; }
	notify(saves);
};

const flushReferences = (client: QueryClient, conversationId: number): Promise<string | null> => {
	const saves = savesOf(conversationId);
	clearTimeout(saves.timer);
	saves.saving = saves.saving.then(async () => {
		for (let next = saves.pending.entries().next(); !next.done; next = saves.pending.entries().next()) {
			const [id, draft] = next.value;
			const result = await commandPainting(conversationId, { type: "save-reference-set", id, expectedReferences: draft.base, references: draft.references });
			if (result.outcome === "reference-set-conflict") {
				const queryKey = illustrationsKey(conversationId);
				await client.cancelQueries({ queryKey });
				client.setQueryData<IllustrationsRead>(queryKey, (read) => read && { ...read, referenceSets: read.referenceSets.map((set) => set.id === id ? result.current : set) });
				saves.conflict = result.current;
				notify(saves);
				return "References changed elsewhere.";
			}
			if (result.outcome !== "available") return result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "The References could not be saved.";
			if (result.value.outcome !== "references-updated") return "The References could not be confirmed.";
			await publishReferenceSelection(client, conversationId, result.value.selection);
			const pending = saves.pending.get(id);
			saves.conflict = undefined;
			updatePending(conversationId, id, pending !== undefined && pending.references !== draft.references ? { ...pending, base: draft.references } : undefined);
		}
		return null;
	}).catch(() => "The References could not be saved.");
	return saves.saving;
};

export async function forkWithSavedReferences(client: QueryClient, conversationId: number, fork: () => Promise<string | null>) {
	const result = await exclusively(conversationId, async () => (await flushReferences(client, conversationId)) ?? await fork());
	return result === false ? "Wait for References to finish updating before forking." : result;
}

export function useReferenceDraft(conversationId: number, selected: ReferenceSet | undefined) {
	const client = useQueryClient();
	const saves = savesOf(conversationId);
	const subscribe = subscribeTo(saves);
	const pending = useSyncExternalStore(subscribe, () => saves.pending);
	const locked = useSyncExternalStore(subscribe, () => saves.locked);
	const conflict = useSyncExternalStore(subscribe, () => saves.conflict);
	const storageUnavailable = useSyncExternalStore(subscribe, () => saves.storageUnavailable);
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
	const resolveConflict = (keep: boolean) => exclusively(conversationId, async () => {
		const current = saves.conflict;
		if (current === undefined) return false;
		const draft = saves.pending.get(current.id);
		saves.conflict = undefined;
		updatePending(conversationId, current.id, keep && draft !== undefined ? { ...draft, base: current.references } : undefined);
		return flush();
	});
	return {
		references: (selected && pending.get(selected.id)?.references) ?? selected?.references ?? "",
		error,
		locked,
		conflict,
		storageUnavailable: storageUnavailable && pending.size > 0,
		resolveConflict,
		edit: (references: string) => {
			if (selected === undefined || saves.locked) return;
			setError(null);
			const base = saves.pending.get(selected.id)?.base ?? selected.references;
			updatePending(conversationId, selected.id, { base, references }, true);
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
	const adopt = (name: string, references: string) => exclusively(conversationId, async () => {
		if (!references.trim()) return true;
		const failure = await flushReferences(client, conversationId);
		setSaveError(failure);
		return failure === null && await submit({ type: "adopt-reference-set", name, references });
	});
	return { adopt, error: saveError ?? error };
}

export const IllustrationActionsContext = createContext<{
	addToComposer: ((name: string, hash: string) => void) | null;
	editBrief: ((variantId: number, brief: string, ask: string) => void) | null;
	editBriefDisabledReason: string | undefined;
} | null>(null);
