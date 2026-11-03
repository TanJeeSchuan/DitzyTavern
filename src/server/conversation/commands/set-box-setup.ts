import { conversationDataTable } from "../../database/schema";
import { boxSetupEntry, readBoxSetups } from "../../box/setup";
import { serverBox } from "../../box/registry";
import { requireBox, requireBoxInstance, type ConversationDatabase } from "../internal";
import { InvalidConversationCommandError } from "../errors";
import type { BoxId } from "../../../shared/contract/box";
import { fitsBoxSchema, type BoxValue } from "../../../shared/contract/box-value";

// @approved
//  The setup must pass its Box's setup schema and `setupError` before it is
// written. Setup belongs to the Box present now, enabled or disabled; an
// absent Box takes none, so nothing outlives a removal into the next insert.
export function setBoxSetup(db: ConversationDatabase, input: { conversationId: number; box: BoxId; setup: BoxValue }) {
	const { label, setup } = requireBox(input.box);
	if (setup === undefined) throw new InvalidConversationCommandError(`The ${label} Box takes no setup.`);
	if (!fitsBoxSchema(setup.schema, input.setup)) throw new InvalidConversationCommandError(`The ${label} setup does not match its schema.`);
	requireBoxInstance(db, input.conversationId, input.box);
	const error = serverBox(input.box)?.setupError?.(input.setup, readBoxSetups(db, input.conversationId)[input.box]);
	if (error !== undefined) throw new InvalidConversationCommandError(error);
	const entry = boxSetupEntry(input.box, input.setup);
	db.insert(conversationDataTable)
		.values({ conversation_id: input.conversationId, ...entry })
		.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: entry.value } })
		.run();
}
