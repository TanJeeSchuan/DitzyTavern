import type { Database } from "bun:sqlite";
import { createConversationModule } from "../conversation";
import type { CastParticipantSnapshot } from "../conversation";
import { referencedDefinitionBlocks } from "../prompt-compiler";
import type {
	ConversationPromptPreset,
	ResolvedPromptPresetSlot,
} from "../../shared/contract/prompt-preset";
import { readConversationPromptPresetRecipe } from "./recipe";

/**
 * ==[HUMAN APPROVED]== The Chat's selected recipe with each Referenced Prompt Block resolved
 * against that Chat's own Conversation-local Participant Definitions and
 * selected narrative path. The preset stores references, never rendered
 * character text or history, so this read is the only place they meet.
 * Undefined when the Conversation does not exist.
 */
export const resolveConversationPromptPreset = (
	database: Database,
	conversationId: number,
): ConversationPromptPreset | undefined => {
	const recipe = readConversationPromptPresetRecipe(database, conversationId);
	const snapshot = createConversationModule(database).getSnapshot(conversationId);
	if (recipe === undefined || snapshot === undefined) return undefined;

	const seated = (
		participantId: number | null,
	): CastParticipantSnapshot | undefined => snapshot.cast.find(
		(participant) => participant.id === participantId,
	);
	const owners = {
		human: seated(snapshot.control.humanParticipantId),
		model: seated(snapshot.control.modelParticipantId),
	};
	// ==[HUMAN APPROVED]== The history slot contributes one entry per Message on the selected
	// narrative path; unlike a Definition slot it has no authored source text
	// to display read-only.
	const historyEntryCount = snapshot.messages.filter(
		(message) => message.variants.some((variant) => variant.selected),
	).length;

	const slots: ResolvedPromptPresetSlot[] = recipe.slots.map((slot) => {
		if (slot.reference === "history") {
			return { reference: "history", enabled: slot.enabled, entryCount: historyEntryCount };
		}
		const referenced = referencedDefinitionBlocks[slot.reference];
		const owner = owners[referenced.owner];
		return {
			reference: slot.reference,
			enabled: slot.enabled,
			sourceName: owner?.name ?? null,
			content: owner?.prompt[referenced.channel] ?? "",
		};
	});

	return { id: recipe.id, name: recipe.name, slots };
};
