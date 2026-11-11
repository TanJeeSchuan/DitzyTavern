import { useQuery } from "@tanstack/react-query";
import { api } from "./lib/eden";
import { requestData, requestOutcome } from "./lib/request-outcome";
import { illustrationsRead, paintingAccepted, paintingErrors, type PaintingCommand } from "../shared/contract/painting";
import { followsChanges } from "./server-changes";

export const illustrationsKey = (conversationId: number | null) => ["illustrations", conversationId] as const;
export const useIllustrations = (conversationId: number | null) => useQuery({
	queryKey: illustrationsKey(conversationId), enabled: conversationId !== null, meta: followsChanges,
	queryFn: () => {
		if (conversationId === null) throw new Error("No Chat selected.");
		return requestData(api.api.conversations({ id: conversationId }).illustrations.get(), illustrationsRead);
	},
});
export const commandPainting = (conversationId: number, command: PaintingCommand) => requestOutcome(api.api.conversations({ id: conversationId }).illustrations.commands.post(command), paintingAccepted, paintingErrors);
