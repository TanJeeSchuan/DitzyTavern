import { conversationDataTable } from "../../database/schema";
import { boxSetupEntry, readBoxSetups } from "../../box/setup";
import { serverBox } from "../../box/registry";
import { requireBoxInstance, type ConversationDatabase } from "../internal";
import { InvalidConversationCommandError } from "../errors";
import { putBoxData } from "./put-box-data";
import type { BoxSetups, SetupBoxId } from "../../../shared/contract/box";
import type { BoxDataWrite } from "../../../shared/contract/box-actions";

type BoxSetupCommand = { [Id in SetupBoxId]: { readonly box: Id; readonly setup: BoxSetups[Id] } }[SetupBoxId];

// @approved
//  Setup belongs to the Box present now, enabled or disabled; an absent Box
// takes none, so nothing outlives a removal into the next insert. The writes
// run through put-box-data in this transaction, so one refused write keeps
// the setup and every other write out.
export function setBoxSetup(db: ConversationDatabase, input: { conversationId: number; writes?: readonly BoxDataWrite[] } & BoxSetupCommand) {
	requireBoxInstance(db, input.conversationId, input.box);
	const { setupError } = serverBox(input.box);
	const error = setupError?.(input.setup, readBoxSetups(db, input.conversationId)[input.box]);
	if (error !== undefined) throw new InvalidConversationCommandError(error);
	for (const write of input.writes ?? []) putBoxData(db, { conversationId: input.conversationId, box: input.box, ...write });
	const entry = boxSetupEntry(input.box, input.setup);
	db.insert(conversationDataTable)
		.values({ conversation_id: input.conversationId, ...entry })
		.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value: entry.value } })
		.run();
}
