import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { boxMetadata, boxReference, type BoxId, type BoxState } from "../../shared/contract/box";
import { loadConversationPromptPreset, type ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand, type ConversationCommandSurface } from "../conversation-command-runner";
import { addPromptPresetReference, setPromptPresetBlockEnabled } from "../prompt-preset-library";

// @approved
//  A preset is shared, so a block a Box adds or enables shows in every Chat's
//  preset editor and notice, not only this Chat's.
export const refreshPresetReads = (client: QueryClient) => Promise.all([
	client.invalidateQueries({ queryKey: ["conversation-preset"] }),
	client.invalidateQueries({ queryKey: ["prompt-preset-editor"] }),
]);

const oneLine = "flex flex-wrap items-center justify-between gap-x-3 gap-y-1";

export const sendBoxState = (surface: ConversationCommandSurface, client: QueryClient, box: BoxId, state: BoxState) =>
	runConversationCommand(surface, { type: "set-box-state", box, state }, {
		onApplied: () => { if (state === "enabled") void refreshPresetReads(client); },
		notices: { conflict: "The Chat changed elsewhere; its Boxes were reloaded.", notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE },
	});

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
	const label = boxMetadata(box).label;
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
	return <Alert className={cn(oneLine, className)}>
		<AlertDescription>{slot === undefined ? `${name} has no ${label} block.` : `${label} block is off in ${name}.`}</AlertDescription>
		<Button type="button" size="xs" variant="outline" disabled={disabled || fix.isPending || preset.isFetching} onClick={() => fix.mutate(id)}>
			{slot === undefined ? "Add block" : "Enable"}
		</Button>
		{fix.isError && <AlertDescription className="basis-full text-destructive">{fix.error.message}</AlertDescription>}
	</Alert>;
}

// @approved
//  A disabled Box keeps its surfaces so the writer can read and configure it;
//  the host's frame for each one says, the same way for every Box, that it
//  does not run.
export function BoxOffNotice({ conversation, box, disabled, onConversationChange, className }: {
	conversation: ConversationSummary;
	box: BoxId;
	disabled: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
	className?: string;
}) {
	const client = useQueryClient();
	const [pending, setPending] = useState(false);
	const [failure, setFailure] = useState<string | null>(null);
	if (conversation.boxes[box] !== "disabled") return null;
	const turnOn = () => {
		setPending(true);
		setFailure(null);
		void sendBoxState({ conversationId: conversation.id, revision: () => conversation.revision, onConversationChange, setNotice: setFailure }, client, box, "enabled")
			.finally(() => setPending(false));
	};
	return <Alert className={cn(oneLine, className)}>
		<AlertDescription>{boxMetadata(box).label} is off in this Chat.</AlertDescription>
		<Button type="button" size="xs" variant="outline" disabled={disabled || pending} onClick={turnOn}>Turn on</Button>
		{failure !== null && <AlertDescription className="basis-full text-destructive">{failure}</AlertDescription>}
	</Alert>;
}
