import { and, eq } from "drizzle-orm";
import { activeGenerationTable, conversationGenerationSettingsTable, messageTable, messageVariantTable } from "../database/schema";
import { ContinuationUnavailableError, InvalidConversationCommandError } from "./errors";
import { DEFAULT_SIBLING_GENERATION_LIMIT } from "./generation-settings";
import { decodeStoredGenerationIntent, isProvisional } from "./generation-state";
import type { ConversationDatabase } from "./internal";
import type { ConversationAction } from "./types";

type GenerationCommand = ConversationAction
	| { type: "delete-conversation" | "fork-conversation" | "accept-tail" | "accept-continuation" }
	| { type: "accept-sibling"; messageId: number }
	| { type: "edit-macro-variables"; position: number };

type CommandType = GenerationCommand["type"];
type Policy =
	| { rule: "allowed" | "same-message-sibling-only" | "continuation" }
	| { rule: "blocked" | "settled-variant" | "settled-macro-position"; reason: string };

const quiet = { rule: "blocked", reason: "A new Conversation turn, Variant creation, or Control mutation is unavailable while an Active Generation exists." } as const;
const deletion = { rule: "blocked", reason: "Stop the running Generation before deleting Messages or Variants." } as const;

const policies = {
	"create-message": quiet,
	"create-variant": quiet,
	"assign-control": quiet,
	"delete-message": deletion,
	"delete-variant": deletion,
	"edit-variant": { rule: "settled-variant", reason: "A Variant cannot be edited while its Generation is running." },
	"set-box-record": { rule: "settled-variant", reason: "This Variant is still generating. Override its record once it settles." },
	"set-message-moves": { rule: "blocked", reason: "Moves cannot change while a Generation is running." },
	"select-variant": { rule: "allowed" },
	"add-participant": { rule: "allowed" },
	"rename-participant": { rule: "allowed" },
	"update-participant-definition": { rule: "allowed" },
	"replace-participant-prompt": { rule: "allowed" },
	"replace-participant-openings": { rule: "allowed" },
	"remove-participant": { rule: "allowed" },
	"put-data": { rule: "allowed" },
	"commit-box": { rule: "allowed" },
	"delete-data": { rule: "allowed" },
	"update-generation-settings": { rule: "allowed" },
	"set-generation-model": { rule: "allowed" },
	"select-prompt-preset": { rule: "allowed" },
	"set-box-setup": { rule: "allowed" },
	"set-box-state": { rule: "allowed" },
	"upgrade-box": { rule: "allowed" },
	"reset-box-record": { rule: "allowed" },
	"rename-conversation": { rule: "allowed" },
	"unlink-fork": { rule: "allowed" },
	"set-background": { rule: "allowed" },
	"attach-chat": { rule: "allowed" },
	"detach-chat": { rule: "allowed" },
	"attach-participant": { rule: "allowed" },
	"detach-participant": { rule: "allowed" },
	"save-settings": { rule: "allowed" },
	"delete-conversation": { rule: "blocked", reason: "Stop the running Generation before deleting this Chat." },
	"fork-conversation": { rule: "blocked", reason: "Cannot fork while an Active Generation exists." },
	"accept-tail": { rule: "blocked", reason: "This Conversation already has an Active Generation." },
	"accept-continuation": { rule: "continuation" },
	"accept-sibling": { rule: "same-message-sibling-only" },
	"edit-macro-variables": { rule: "settled-macro-position", reason: "Macro Variables cannot change on a Variant while its Generation is running." },
} satisfies Record<CommandType, Policy>;

export function generationGate(db: ConversationDatabase, conversationId: number, command: GenerationCommand): void {
	const policy = policies[command.type];
	if (policy.rule === "allowed") return;
	const active = db.select({
		messageId: activeGenerationTable.message_id,
		variantId: activeGenerationTable.variant_id,
		intent: activeGenerationTable.generation_intent_json,
	}).from(activeGenerationTable).where(eq(activeGenerationTable.conversation_id, conversationId)).all();
	if (active.length === 0) return;
	switch (policy.rule) {
		case "blocked": throw new InvalidConversationCommandError(policy.reason);
		case "continuation": throw new ContinuationUnavailableError("active-generation");
		case "settled-variant":
			if ("variantId" in command && isProvisional(command.variantId, active)) throw new InvalidConversationCommandError(policy.reason);
			return;
		case "settled-macro-position": {
			if (command.type !== "edit-macro-variables" || command.position === 0) return;
			const variant = db.select({ id: messageVariantTable.id }).from(messageVariantTable)
				.innerJoin(messageTable, eq(messageTable.id, messageVariantTable.message_id))
				.where(and(eq(messageTable.conversation_id, conversationId), eq(messageTable.position, command.position), eq(messageVariantTable.selected, true))).get();
			if (variant !== undefined && isProvisional(variant.id, active)) throw new InvalidConversationCommandError(policy.reason);
			return;
		}
		case "same-message-sibling-only": {
			if (active.some((row) => decodeStoredGenerationIntent(row.intent).type !== "sibling")) {
				throw new InvalidConversationCommandError("A Sibling Generation cannot start while an Active Generation exists.");
			}
			if ("messageId" in command && active.some((row) => row.messageId !== command.messageId)) {
				throw new InvalidConversationCommandError("Sibling Generations are allowed only at the active response position.");
			}
			const limit = db.select({ value: conversationGenerationSettingsTable.sibling_generation_limit })
				.from(conversationGenerationSettingsTable).where(eq(conversationGenerationSettingsTable.conversation_id, conversationId))
				.get()?.value ?? DEFAULT_SIBLING_GENERATION_LIMIT;
			if (active.length >= limit) throw new InvalidConversationCommandError(`The Conversation already has ${limit} active Sibling Generations at this response position.`);
		}
	}
}
