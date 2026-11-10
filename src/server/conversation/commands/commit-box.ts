import { and, eq } from "drizzle-orm";
import { isActive } from "../../database/is-active";
import type { BoxId } from "../../../shared/contract/box";
import type { BoxDataExpectation, BoxDataWrite } from "../../../shared/contract/box-actions";
import { Value } from "@sinclair/typebox/value";
import type { BoxValue } from "../../../shared/contract/box-value";
import { characterTable } from "../../database/schema";
import { putCharacterValue, putLibraryValue, putParticipantValue, readCharacterRevisions, readLibraryValues } from "../../box/stored-value";
import { InvalidConversationCommandError } from "../errors";
import { readActiveCast, requireBox, requireBoxInstance, requireParticipant, type ConversationDatabase } from "../internal";
import { readBoxVersions } from "../../box/version-pin";
import { setBoxSetup } from "./set-box-setup";

type Owner = BoxDataWrite["owner"];
const parsedJson = (value: string): BoxValue | undefined => {
	try { return JSON.parse(value); } catch { return undefined; }
};
const sameOwner = (guard: BoxDataExpectation["owner"], owner: Owner) =>
	guard.type === owner.type && (guard.type !== "character" || owner.type !== "character" || guard.characterId === owner.characterId);

// @approved
//  The host command behind every commit from a Box's window, in the command's
// one transaction, so a refused setup, guard or write lands nothing. Only a
// Box present in the Chat, enabled or disabled, has a window, so a commit
// for an absent Box is refused, as its setup is. A Character must be live
// and the source of someone in this Chat's Cast, and a Participant must
// belong to this Chat; anything else is a typed invalid command, never a
// silent orphan row. A Participant value must be JSON its declared schema
// accepts, and each `expected` revision must still be current. A window
// names the version its frame runs, and one that is not the version the Chat
// pins is refused even at the current revision, so a window left open on an
// earlier version writes nothing after an upgrade.
export function commitBox(db: ConversationDatabase, input: { conversationId: number; box: BoxId; version?: string; setup?: BoxValue; writes?: readonly BoxDataWrite[]; expected?: readonly BoxDataExpectation[] }) {
	const { conversationId, box, setup, writes = [], expected = [] } = input;
	requireBoxInstance(db, conversationId, box);
	if (readBoxVersions(db, conversationId)[box] !== input.version) throw new InvalidConversationCommandError(`This ${box} window runs a version this Chat no longer uses. Close it and open it again.`);
	const { descriptor } = requireBox(db, conversationId, box);
	const sources = new Set(readActiveCast(db, conversationId).flatMap(({ sourceCharacterId }) => sourceCharacterId ?? []));
	for (const { owner, key, revision } of expected) {
		if (owner.type === "character") {
			const live = db.select({ id: characterTable.id }).from(characterTable).where(and(eq(characterTable.id, owner.characterId), isActive(characterTable))).get();
			if (live === undefined || !sources.has(owner.characterId)) throw new InvalidConversationCommandError(`Character ${owner.characterId} is not the source of anyone in this Chat's Cast.`);
		}
		const current = owner.type === "library" ? readLibraryValues(db, box, key).find((row) => row.key === key) : readCharacterRevisions(db, box, key, [owner.characterId])[0];
		if ((current?.revision ?? 0) !== revision) throw new InvalidConversationCommandError("Another Chat changed this value since it was read. Review it and try again.");
	}
	if (setup !== undefined) setBoxSetup(db, { conversationId, box, setup });
	for (const { owner, key, value } of writes) {
		if (owner.type === "participant") {
			requireParticipant(db, conversationId, owner.participantId);
			const schema = descriptor.values?.participant?.[key];
			if (schema !== undefined && !Value.Check(schema, parsedJson(value))) throw new InvalidConversationCommandError(`The ${box} Box's ${key} value does not match its schema.`);
			putParticipantValue(db, descriptor, owner.participantId, { key, value });
			continue;
		}
		if (!expected.some((guard) => guard.key === key && sameOwner(guard.owner, owner))) throw new InvalidConversationCommandError(`A ${owner.type} write needs the revision it was read at in expected.`);
		if (owner.type === "library") putLibraryValue(db, box, { key, value }, () => undefined);
		else putCharacterValue(db, box, owner.characterId, { key, value }, () => undefined);
	}
}
