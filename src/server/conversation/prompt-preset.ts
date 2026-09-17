import type { Database } from "bun:sqlite";
import { and, count, eq } from "drizzle-orm";
import { referencedDefinitionBlocks } from "../prompt-compiler";
import { readConversationPromptPresetRecipeFromConnection } from "../prompt-preset";
import {
	messageTable,
	messageVariantTable,
} from "../database/schema";
import {
	readActiveCast,
	readControlAssignment,
	type ActiveCastRow,
} from "./internal";
import { runConversationReadTransaction } from "./commands/transaction";
import type {
	ConversationPromptPreset,
	PromptPresetRecipe,
	ResolvedPromptPresetSlot,
} from "../../shared/contract/prompt-preset";

// ==[HUMAN APPROVED]== The Chat's selected recipe with each Referenced Prompt Block resolved
// against that Chat's own Conversation-local Participant Definitions and
// selected narrative path. The preset stores references, never rendered
// character text or history, so this read is the only place they meet. The
// projection is Conversation-owned while the preset library stays independent
// of the Conversation module.
const projectPromptPreset = (
	recipe: PromptPresetRecipe,
	context: {
		owners: { human: ActiveCastRow | undefined; model: ActiveCastRow | undefined };
		historyEntryCount: number;
	},
): ConversationPromptPreset => {
	const { owners, historyEntryCount } = context;

	const slots: ResolvedPromptPresetSlot[] = recipe.slots.map((slot) => {
		if (slot.reference === "history") {
			return {
				id: slot.id,
				reference: "history",
				enabled: slot.enabled,
				entryCount: historyEntryCount,
			};
		}
		if (slot.reference === "instruction") {
			// ==[HUMAN APPROVED]== An instruction occurrence's resolved view is its stored authored
			// name and text, exactly what the editor shows and Generation
			// compiles; there is no Conversation-local source to read. The
			// stored recipe read guarantees its outgoing role.
			return {
				id: slot.id,
				reference: slot.reference,
				enabled: slot.enabled,
				role: slot.role,
				name: slot.name,
				content: slot.content,
			};
		}
		if (slot.reference === "lore") {
			return {
				id: slot.id,
				reference: slot.reference,
				enabled: slot.enabled,
				role: slot.role,
				entryCount: 0,
			};
		}
		const referenced = referencedDefinitionBlocks[slot.reference];
		const owner = owners[referenced.owner];
		return {
			id: slot.id,
			reference: slot.reference,
			enabled: slot.enabled,
			role: slot.role,
			sourceName: owner?.name ?? null,
			content: owner?.[referenced.channel] ?? "",
		};
	});

	return { id: recipe.id, name: recipe.name, slots };
};

/** ==[HUMAN APPROVED]== Undefined when the Conversation does not exist. */
export const readConversationPromptPreset = (
	database: Database,
	conversationId: number,
): ConversationPromptPreset | undefined =>
	runConversationReadTransaction(database, (db) => {
		const recipe = readConversationPromptPresetRecipeFromConnection(db, conversationId);
		if (recipe === undefined) return undefined;
		const control = readControlAssignment(db, conversationId);
		const controlledIds = [control.humanParticipantId, control.modelParticipantId]
			.filter((id): id is number => id !== null);
		const cast = controlledIds.length === 0
			? []
			: readActiveCast(db, conversationId, controlledIds);
		const owners = {
			human: cast.find((participant) => participant.id === control.humanParticipantId),
			model: cast.find((participant) => participant.id === control.modelParticipantId),
		};
		// ==[HUMAN APPROVED]== A selected Variant is one history entry. Count it in SQL instead of
		// materializing all Messages and alternative Variants just to inspect the
		// resolved recipe.
		const historyEntryCount = db
			.select({ value: count(messageTable.id) })
			.from(messageTable)
			.innerJoin(messageVariantTable, and(
				eq(messageVariantTable.message_id, messageTable.id),
				eq(messageVariantTable.selected, true),
			))
			.where(eq(messageTable.conversation_id, conversationId))
			.get()?.value ?? 0;
		return projectPromptPreset(recipe, { owners, historyEntryCount });
	});
