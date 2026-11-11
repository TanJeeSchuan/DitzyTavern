import type { Database } from "bun:sqlite";
import type { ConversationWriteChange } from "../../shared/contract/conversation-write-change";
import { prepareBoxDigests } from "../box/digest";
import { processStateFor } from "./process-state";

export const prepareConversationEffects = (database: Database, change: ConversationWriteChange) => {
	const publish = prepareBoxDigests(database, change);
	return () => {
		processStateFor(database).paintings.abortVariants(change.removedVariantIds);
		publish();
	};
};
