import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { boxMetadata, heldBoxValues, heldBoxValuesCleared, type BoxId } from "../../shared/contract/box";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { api } from "../lib/eden";
import { requestData, requestOutcome } from "../lib/request-outcome";

const counted = (places: readonly string[]) => `${places.length} stored ${places.length === 1 ? "value" : "values"}`;

// @approved
//  After a Box's update, the stored values its new schemas reject and its
// upgrade could not rewrite stay as they were, and every read of them fails,
// a held setup failing its whole Chat. So this needs no Chat: it names how
// many each Box holds, across every Chat, and offers to delete them, then
// reloads every Chat it may have kept from loading.
export function BoxHeldNotices({ disabled }: { disabled: boolean }) {
	const client = useQueryClient();
	const [confirming, setConfirming] = useState<BoxId | null>(null);
	const held = useQuery({ queryKey: ["box-held-values"], queryFn: () => requestData(api.api["box-held-values"].get(), heldBoxValues) });
	const clear = useMutation({
		mutationFn: async (box: BoxId) => {
			const outcome = await requestOutcome(api.api.boxes({ box })["held-values"].clear.post(), heldBoxValuesCleared, notFoundOutcome);
			if (outcome.outcome !== "available" && outcome.outcome !== "not-found") throw new Error(outcome.outcome === "network" ? "The server could not be reached." : outcome.reason);
		},
		onSettled: () => Promise.all([client.invalidateQueries({ queryKey: ["box-held-values"] }), client.invalidateQueries({ queryKey: ["conversation"] })]),
	});
	const boxes = Object.entries(held.data ?? {});
	if (boxes.length === 0) return null;
	const places = confirming === null ? [] : held.data?.[confirming] ?? [];
	return <>
		{boxes.map(([box, entries]) => <Alert key={box} className="mx-3 mt-3 w-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
			<AlertDescription>{boxMetadata(box).label} was updated: {counted(entries)} no longer {entries.length === 1 ? "fits" : "fit"}.</AlertDescription>
			<Button type="button" size="xs" variant="outline" disabled={disabled || clear.isPending} onClick={() => setConfirming(box)}>Clear…</Button>
		</Alert>)}
		{clear.isError && <p className="composer-control-note is-error mx-3" role="alert">{clear.error.message}</p>}
		<Dialog open={confirming !== null} onOpenChange={(open) => { if (!open) setConfirming(null); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Clear {counted(places)}?</DialogTitle>
					<DialogDescription>This deletes {places.length === 1 ? "it" : "them"}: {places.slice(0, 3).join(", ")}{places.length > 3 ? ", …" : ""}.</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => setConfirming(null)}>Keep them</Button>
					<Button type="button" variant="destructive" onClick={() => { if (confirming !== null) clear.mutate(confirming); setConfirming(null); }}>Clear</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	</>;
}
