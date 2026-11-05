import type { BoxId } from "../../../shared/contract/box";
import type { ConversationWriteChange } from "../../../shared/contract/conversation-write-change";
import { boxAt } from "../../box/registry";
import { refusedUpgrade, upgradeRefusals } from "../box-upgrade";
import { pinBoxVersion } from "../../box/version-pin";
import { InvalidConversationCommandError } from "../errors";
import { requireBox, type ConversationDatabase } from "../internal";

// @approved
//  Moves this Chat's pin of a versioned Box to `version`, newer or older,
// in the command's one transaction: the upgrade check reads the Chat's
// stored data for the Box and writes nothing, and only when no place fails
// does the pin move, keeping the insertion instance, so every record still
// folds. A refusal lists each failing place. The Box's queued digests are
// dropped, since their results would land for the version the Chat left.
// The route loads `version` before the command runs.
export function upgradeBox(db: ConversationDatabase, input: { conversationId: number; box: BoxId; version: string }): ConversationWriteChange {
	const from = requireBox(db, input.conversationId, input.box);
	const { label } = from.descriptor;
	if (from.version === undefined) throw new InvalidConversationCommandError(`The ${label} Box is not versioned.`);
	if (from.version === input.version) throw new InvalidConversationCommandError(`This Chat already runs that version of the ${label} Box.`);
	const to = boxAt(input.box, input.version);
	if (to === undefined) throw new InvalidConversationCommandError(`The ${label} Box has no version ${input.version}.`);
	const refusals = upgradeRefusals(db, input.conversationId, from, to);
	if (refusals.length > 0) throw new InvalidConversationCommandError(refusedUpgrade(label, refusals));
	pinBoxVersion(db, input.conversationId, input.box, input.version);
	return { conversationId: input.conversationId, touchedVariantIds: [], removedVariantIds: [], stoppedBox: input.box };
}
