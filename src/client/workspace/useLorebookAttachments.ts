import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getLorebookAttachmentState } from "../lorebook-library";
import { loadConversationPromptPreset, type ConversationAction } from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import { addPromptPresetReference, setPromptPresetBlockEnabled } from "../prompt-preset-library";
import { hasEnabledLoreSlot } from "../../shared/contract/prompt-preset";
import { publishConversation } from "../conversation-query";

type LoreAttachmentAction = Extract<ConversationAction, { type: "attach-chat" | "detach-chat" | "attach-participant" | "detach-participant" | "save-lore-settings" }>;
const attachmentNotice = "Lorebook attachment settings changed elsewhere.";

export function useLorebookAttachments(conversationId: number) {
	const client = useQueryClient();
	const attachmentKey = ["lorebook-attachments", conversationId];
	const attachments = useQuery({ queryKey: attachmentKey, queryFn: ({ signal }) => getLorebookAttachmentState(conversationId, signal) });
	const preset = useQuery({ queryKey: ["conversation-preset", conversationId], queryFn: ({ signal }) => loadConversationPromptPreset(conversationId, signal) });
	const selectedPreset = preset.data ?? null;
	const write = useMutation({
		mutationKey: attachmentKey,
		networkMode: "always",
		mutationFn: async ({ action, revision }: { action: LoreAttachmentAction; revision: number }) => {
			let reason = attachmentNotice;
			const applied = await runConversationCommand({
				conversationId, revision: () => revision, exact: true,
				onConversationChange: (conversation) => publishConversation(client, conversation),
				setNotice: (notice) => { reason = notice; },
			}, action, { notices: { conflict: attachmentNotice, notFound: attachmentNotice, unreachable: attachmentNotice } });
			await client.cancelQueries({ queryKey: attachmentKey });
			await client.invalidateQueries({ queryKey: ["lorebook-attachments"] });
			if (!applied) throw new Error(reason);
		},
	});
	const enable = useMutation({
		mutationKey: ["lorebook-preset", conversationId],
		mutationFn: async () => {
			if (selectedPreset === null) return null;
			const lore = selectedPreset.slots.find((slot) => slot.reference === "lore");
			const result = lore === undefined ? await addPromptPresetReference(selectedPreset.id, "lore") : await setPromptPresetBlockEnabled(selectedPreset.id, lore.id, true);
			if (result.outcome !== "available") throw new Error("The Prompt Preset rejected the Lore block change.");
			await client.invalidateQueries({ queryKey: ["conversation-preset", conversationId] });
			return lore === undefined ? "Lore block added to the selected Prompt Preset." : "Lore block enabled in the selected Prompt Preset.";
		},
	});
	return {
		attachmentState: attachments.data ?? null, selectedPreset,
		loreBlockMissing: selectedPreset !== null && !hasEnabledLoreSlot(selectedPreset.slots),
		attachmentPending: write.isPending || enable.isPending,
		notice: write.error?.message ?? enable.error?.message ?? enable.data ?? attachments.error?.message ?? preset.error?.message ?? null,
		updateAttachment: (action: LoreAttachmentAction) => {
			const revision = attachments.data?.revision;
			return revision === undefined ? Promise.resolve(false) : write.mutateAsync({ action, revision }).then(() => true, () => false);
		},
		enableLoreSlot: () => enable.mutate(),
	};
}
