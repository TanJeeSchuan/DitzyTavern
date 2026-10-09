import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { applyLorebookAttachmentCommand, getLorebookAttachmentState, type LoreAttachmentCommand } from "../lorebook-library";
import { loadConversationPromptPreset } from "../conversation";
import { addPromptPresetReference, setPromptPresetBlockEnabled } from "../prompt-preset-library";
import { hasEnabledLoreSlot } from "../../shared/contract/prompt-preset";
import { conversationKey, publishConversation } from "../conversation-query";

export function useLorebookAttachments(conversationId: number) {
	const client = useQueryClient();
	const attachments = useQuery({ queryKey: ["lorebook-attachments", conversationId], queryFn: ({ signal }) => getLorebookAttachmentState(conversationId, signal) });
	const preset = useQuery({ queryKey: ["conversation-preset", conversationId], queryFn: ({ signal }) => loadConversationPromptPreset(conversationId, signal) });
	const selectedPreset = preset.data ?? null;
	const write = useMutation({
		mutationKey: ["lorebook-attachments", conversationId],
		mutationFn: async (command: LoreAttachmentCommand) => {
			const result = await applyLorebookAttachmentCommand(command);
			await client.cancelQueries({ queryKey: ["lorebook-attachments", conversationId] });
			await client.invalidateQueries({ queryKey: ["lorebook-attachments", conversationId] });
			if (result.outcome === "conflict" && "currentConversation" in result) publishConversation(client, result.currentConversation);
			if (result.outcome === "available") void client.invalidateQueries({ queryKey: conversationKey(conversationId) });
			if (result.outcome !== "available") throw new Error(result.outcome === "invalid" || result.outcome === "unusable" ? result.reason : "Lorebook attachment settings changed elsewhere.");
			return true;
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
		updateAttachment: async (command: LoreAttachmentCommand) => { try { return await write.mutateAsync(command); } catch { return false; } },
		enableLoreSlot: () => enable.mutate(),
	};
}
