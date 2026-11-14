import { createContext, useEffect, useState, useSyncExternalStore } from "react";
import { modelSelectionClient } from "./model-selection-client";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import { illustrationsRead, galleryRead, paintingAccepted, paintingErrors, type PaintingCommand, type IllustrationsRead, type ReferenceSet } from "../shared/contract/painting";
import { followsChanges } from "./server-changes";

export const illustrationsKey = (conversationId: number | null) => ["illustrations", conversationId] as const;
export const useIllustrations = (conversationId: number | null, variantId?: number) => useQuery({
	queryKey: illustrationsKey(conversationId), enabled: conversationId !== null, meta: followsChanges, refetchOnMount: variantId === undefined,
	select: (read: IllustrationsRead) => variantId === undefined ? read : { ...read, paintings: read.paintings.filter((painting) => painting.variantId === variantId) },
	queryFn: () => {
		if (conversationId === null) throw new Error("No Chat selected.");
		return requestData(api.api.conversations({ id: conversationId }).illustrations.get(), illustrationsRead);
	},
});
export const useGallery = (conversationId: number) => useQuery({
	queryKey: ["gallery", conversationId], meta: followsChanges,
	queryFn: () => requestData(api.api.conversations({ id: conversationId }).gallery.get(), galleryRead),
});

export const commandPainting = (conversationId: number, command: PaintingCommand) => requestOutcome(api.api.conversations({ id: conversationId }).illustrations.commands.post(command), paintingAccepted, paintingErrors);

export function usePaintingCommand(conversationId: number) {
	const client = useQueryClient();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const submit = async (command: PaintingCommand) => {
		setPending(true);
		setError(null);
		try {
			const result = await commandPainting(conversationId, command);
			if (result.outcome === "available") await client.invalidateQueries({ queryKey: illustrationsKey(conversationId) });
			else setError(result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "The painting could not be updated. Try again.");
			return result.outcome === "available";
		} finally { setPending(false); }
	};
	return { submit, pending, error };
}

export type PaintTarget = { variantId: number; brief: string; ask: string; requestId: string };

type ReferenceSaves = { pending: ReadonlyMap<string, string>; timer?: ReturnType<typeof setTimeout>; saving: Promise<string | null>; listeners: Set<() => void> };
const referenceSaves = new Map<number, ReferenceSaves>();
const savesOf = (conversationId: number) => {
	const saves: ReferenceSaves = referenceSaves.get(conversationId) ?? { pending: new Map(), saving: Promise.resolve(null), listeners: new Set() };
	referenceSaves.set(conversationId, saves);
	return saves;
};
const setPending = (saves: ReferenceSaves, id: string, references: string | undefined) => {
	const pending = new Map(saves.pending);
	if (references === undefined) pending.delete(id);
	else pending.set(id, references);
	saves.pending = pending;
	for (const listener of saves.listeners) listener();
};

export const flushReferences = (client: QueryClient, conversationId: number): Promise<string | null> => {
	const saves = savesOf(conversationId);
	clearTimeout(saves.timer);
	saves.saving = saves.saving.then(async () => {
		for (let next = saves.pending.entries().next(); !next.done; next = saves.pending.entries().next()) {
			const [id, references] = next.value;
			const result = await commandPainting(conversationId, { type: "save-reference-set", id, references });
			if (result.outcome !== "available") return result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "The References could not be saved.";
			await client.invalidateQueries({ queryKey: illustrationsKey(conversationId) });
			if (saves.pending.get(id) === references) setPending(saves, id, undefined);
		}
		return null;
	});
	return saves.saving;
};

export function useReferenceDraft(conversationId: number, selected: ReferenceSet | undefined) {
	const client = useQueryClient();
	const saves = savesOf(conversationId);
	const pending = useSyncExternalStore((listener) => {
		saves.listeners.add(listener);
		return () => { saves.listeners.delete(listener); };
	}, () => saves.pending);
	const [error, setError] = useState<string | null>(null);
	const flush = async () => {
		const failure = await flushReferences(client, conversationId);
		setError(failure);
		return failure === null;
	};
	useEffect(() => () => void flushReferences(client, conversationId), [client, conversationId]);
	return {
		references: (selected && pending.get(selected.id)) ?? selected?.references ?? "",
		error,
		edit: (references: string) => {
			if (selected === undefined) return;
			setError(null);
			setPending(saves, selected.id, references);
			clearTimeout(saves.timer);
			saves.timer = setTimeout(() => void flush(), 600);
		},
		flush,
	};
}

export function useAdoptReferences(conversationId: number) {
	const client = useQueryClient();
	const { submit, error } = usePaintingCommand(conversationId);
	const [saveError, setSaveError] = useState<string | null>(null);
	const adopt = async (name: string, references: string) => {
		if (!references.trim()) return true;
		const failure = await flushReferences(client, conversationId);
		setSaveError(failure);
		return failure === null && submit({ type: "adopt-reference-set", name, references });
	};
	return { adopt, error: saveError ?? error };
}

const imageModelClient = modelSelectionClient("image-model");
export function useImageModel() {
	const client = useQueryClient();
	const read = useQuery({ queryKey: ["image-model"], meta: followsChanges, queryFn: imageModelClient.load });
	const [error, setError] = useState<string | null>(null);
	const select = async (profileId: number, model: string) => {
		if (read.data === undefined) return;
		setError(null);
		const result = await imageModelClient.save({ type: "apply", expectedRevision: read.data.revision, profileId, model });
		if (result.outcome === "available") client.setQueryData(["image-model"], result.value.settings);
		else if (result.outcome === "conflict") {
			client.setQueryData(["image-model"], result.currentSettings);
			setError("The Image Model changed elsewhere. Choose again.");
		} else setError(result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "The Image Model could not be saved.");
	};
	return { selected: read.data, select, error };
}

export const IllustrationActionsContext = createContext<{
	addToComposer: ((name: string, hash: string) => void) | null;
	editBrief: ((variantId: number, brief: string, ask: string) => void) | null;
	editBriefDisabledReason: string | undefined;
} | null>(null);
