import type { Database } from "bun:sqlite";
import type { BoxId } from "../../shared/contract/box";
import type { BoxValue } from "../../shared/contract/box-value";
import type { GenerationJsonValue } from "../../shared/generation-json";
import { readConversationSummaryFromConnection, readSelectedHistoryFromConnection, runConversationReadTransaction } from "../conversation";
import type { BoxWindowRead } from "./contract";
import { readBoxFold } from "./records";
import { chatBox, type LoadedBox } from "./registry";
import { readBoxLifecycles } from "./setup";

/** @approved A window read as the host folds it, with the Box's record slots on the Selected path, which the passage timeline lists. */
export type HostWindowRead = BoxWindowRead<BoxValue | undefined, GenerationJsonValue | undefined> & Pick<ReturnType<typeof readBoxFold>, "slots">;

// @approved
//  A Box window's read: the Chat, its Selected path, and the Box's setup and
// fold over the path's effective records, at the version the Chat runs, read
// in one transaction and folded as Generation capture folds them. A missing
// Chat or Box reads as undefined, which the route answers with 404.
export const readBoxWindow = <Read>(database: Database, conversationId: number, id: BoxId, read: (window: HostWindowRead, loaded: LoadedBox) => Read): Read | undefined =>
	runConversationReadTransaction(database, (db) => {
		const summary = readConversationSummaryFromConnection(db, conversationId);
		const history = summary === undefined ? undefined : readSelectedHistoryFromConnection(db, conversationId, { conversationData: false });
		const loaded = summary === undefined ? undefined : chatBox(db, conversationId, id);
		if (summary === undefined || history === undefined || loaded === undefined) return undefined;
		const setup = summary.boxSetups[id];
		const variantIds = history.messages.flatMap(({ variant }) => variant === null ? [] : [variant.id]);
		return read({ db, conversationId, summary, history, setup, ...readBoxFold(db, loaded, readBoxLifecycles(db, conversationId)[id]?.instance, setup, variantIds) }, loaded);
	});
