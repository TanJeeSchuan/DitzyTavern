import { conversationDataTable } from "../../database/schema";
import { boxSetupEntry, readBoxSetups } from "../../box/setup";
import { serverBox } from "../../box/registry";
import { requireBox, requireBoxInstance, type ConversationDatabase } from "../internal";
import { InvalidConversationCommandError } from "../errors";
import { putBoxData } from "./put-box-data";
import type { BoxId } from "../../../shared/contract/box";
import { fitsBoxSchema, type BoxValue } from "../../../shared/contract/box-value";
import type { BoxDataWrite } from "../../../shared/contract/box-actions";

// @approved
//  The setup must pass its Box's setup schema before anything is written.
// Setup belongs to the Box present now, enabled or disabled; an absent Box
// takes none, so nothing outlives a removal into the next insert. The writes
// run through put-box-data in this transaction, so one refused write keeps
// the setup and every other write out.
export function setBoxSetup(db: ConversationDatabase, input: { conversationId: number; box: BoxId; setup: BoxValue; writes?: readonly BoxDataWrite[] }) {
	const { label, setup } = requireBox(input.box);
	if (setup === undefined) throw new InvalidConversationCommandError(`The ${label} Box takes no setup.`);
	if (!fitsBoxSchema(setup.schema, input.setup)) throw new InvalidConversationCommandError(`The ${label} setup does not match its schema.`);
	requireBoxInstance(db, input.conversationId, input.box);
	const error = serverBox(input.box)?.setupError?.(input.setup, readBoxSetups(db, input.conversationId)[input.box]);
	if (error !== undefined) throw new InvalidConversationCommandError(error);
	for (const write of input.writes ?? []) putBoxData(db, { conversationId: input.conversationId, box: input.box, ...write });
	const entry = boxSetupEntry(input.box, input.setup);
	db.insert(conversationDataTable)
		.values({ conversation_id: input.conversationId, ...entry })
		.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: entry.value } })
		.run();
}
