import { createContext, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import { illustrationsRead, galleryRead, paintingAccepted, paintingErrors, type PaintingCommand, type IllustrationsRead } from "../shared/contract/painting";
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

export const IllustrationActionsContext = createContext<{
	addToComposer: ((name: string, hash: string) => void) | null;
	editBrief: (variantId: number, brief: string, ask: string) => void;
} | null>(null);
