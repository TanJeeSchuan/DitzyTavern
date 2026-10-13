import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { boxReference, type BoxId } from "../../shared/contract/box";
import { loadConversationPromptPreset, type ConversationSummary } from "../conversation";
import { addPromptPresetReference, setPromptPresetBlockEnabled } from "../prompt-preset-library";
import { boxTitle } from "./registry";

// @approved
//  A preset is shared, so a block a Box adds or enables shows in every Chat's
//  preset editor and notice, not only this Chat's.
export const refreshPresetReads = (client: QueryClient) => Promise.all([
	client.invalidateQueries({ queryKey: ["conversation-preset"] }),
	client.invalidateQueries({ queryKey: ["prompt-preset-editor"] }),
]);

// @approved
//  A Box On in this Chat whose preset block is missing or off runs every turn
//  and sends nothing. Turning the Box on adds a missing block but leaves a
//  disabled one off, so this shows when an author turned the block off or
//  deleted it, and offers the one fix.
export function BoxBlockNotice({ conversation, box, disabled, className }: {
	conversation: ConversationSummary;
	box: BoxId;
	disabled: boolean;
	className?: string;
}) {
	const client = useQueryClient();
	const on = conversation.boxes[box] === "enabled";
	const preset = useQuery({
		queryKey: ["conversation-preset", conversation.id, conversation.revision],
		queryFn: ({ signal }) => loadConversationPromptPreset(conversation.id, signal),
		enabled: on,
	});
	const label = boxTitle(box);
	const slot = preset.data?.slots.find((entry) => entry.reference === boxReference(box));
	const fix = useMutation({
		mutationFn: async (presetId: number) => {
			const outcome = slot === undefined
				? await addPromptPresetReference(presetId, boxReference(box))
				: await setPromptPresetBlockEnabled(presetId, slot.id, true);
			if (outcome.outcome !== "available") throw new Error(outcome.outcome === "invalid" || outcome.outcome === "unusable" ? outcome.reason : `The ${label} block could not be updated.`);
		},
		onSuccess: () => refreshPresetReads(client),
	});
	if (!on || !preset.data || slot?.enabled) return null;
	const { id, name } = preset.data;
	return <Alert className={className}>
		<AlertDescription>{slot === undefined ? `${name} has no ${label} block.` : `${label} block is off in ${name}.`}</AlertDescription>
		{fix.isError && <AlertDescription className="text-destructive">{fix.error.message}</AlertDescription>}
		<Button type="button" size="xs" variant="outline" className="mt-1 w-fit" disabled={disabled || fix.isPending || preset.isFetching} onClick={() => fix.mutate(id)}>
			{slot === undefined ? "Add block" : "Enable"}
		</Button>
	</Alert>;
}

// @approved
//  A disabled Box keeps its surfaces so the writer can read and configure it;
//  the host's frame for each one says, the same way for every Box, that it
//  does not run.
export function BoxOffNotice({ conversation, box, className }: { conversation: ConversationSummary; box: BoxId; className?: string }) {
	if (conversation.boxes[box] !== "disabled") return null;
	return <Alert className={className}>
		<AlertDescription>{boxTitle(box)} is off in this Chat. Turn it on in Boxes to run it and take its Moves; its setup and saved data stay editable here.</AlertDescription>
	</Alert>;
}
