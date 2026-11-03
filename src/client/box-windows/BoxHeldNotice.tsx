import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { heldBoxValues, heldBoxValuesCleared, type BoxId } from "../../shared/contract/box";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { loadConversation, type ConversationSummary } from "../conversation";
import { api } from "../lib/eden";
import { requestData, requestOutcome } from "../lib/request-outcome";

// @approved
//  After a Box's update, the stored values its new schemas reject and its
// upgrade could not rewrite stay as they were, and every read of them fails.
// This names how many there are, across every Chat, and offers to delete
// them; nothing else changes them.
export function BoxHeldNotice({ conversation, box, disabled, onConversationChange }: {
	conversation: ConversationSummary;
	box: BoxId;
	disabled: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
}) {
	const client = useQueryClient();
	const [confirming, setConfirming] = useState(false);
	const held = useQuery({ queryKey: ["box-held-values"], queryFn: () => requestData(api.api["box-held-values"].get(), heldBoxValues) });
	const clear = useMutation({
		mutationFn: async () => {
			const outcome = await requestOutcome(api.api.boxes({ box })["held-values"].clear.post(), heldBoxValuesCleared, notFoundOutcome);
			if (outcome.outcome !== "available" && outcome.outcome !== "not-found") throw new Error(outcome.outcome === "network" ? "The server could not be reached." : outcome.reason);
			const summary = await loadConversation(conversation.id);
			if (summary !== null) onConversationChange(summary);
		},
		onSettled: () => client.invalidateQueries({ queryKey: ["box-held-values"] }),
	});
	const places = held.data?.[box];
	if (places === undefined) return null;
	const count = `${places.length} stored ${places.length === 1 ? "value" : "values"}`;
	return <>
		<Alert className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
			<AlertDescription>{count} no longer {places.length === 1 ? "fits" : "fit"}.</AlertDescription>
			<Button type="button" size="xs" variant="outline" disabled={disabled || clear.isPending} onClick={() => setConfirming(true)}>Clear…</Button>
			{clear.isError && <AlertDescription className="basis-full text-destructive">{clear.error.message}</AlertDescription>}
		</Alert>
		<Dialog open={confirming} onOpenChange={setConfirming}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Clear {count}?</DialogTitle>
					<DialogDescription>This deletes {places.length === 1 ? "it" : "them"}: {places.slice(0, 3).join(", ")}{places.length > 3 ? ", …" : ""}.</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => setConfirming(false)}>Keep them</Button>
					<Button type="button" variant="destructive" onClick={() => { setConfirming(false); clear.mutate(); }}>Clear</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	</>;
}
