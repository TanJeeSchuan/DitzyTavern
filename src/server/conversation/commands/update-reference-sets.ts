import { and, eq, like } from "drizzle-orm";
import { Value } from "@sinclair/typebox/value";
import { conversationDataTable } from "../../database/schema";
import { referenceSet, type ReferenceSet, type ReferenceSetCommand } from "../../../shared/contract/reference-set";
import { PAINTING_NAMESPACE } from "../../../shared/variant-data-codecs";
import { InvalidConversationCommandError } from "../errors";
import type { ConversationDatabase } from "../internal";

const initial: ReferenceSet = { id: "default", name: "References", references: "" };
const prefix = "reference-set:";
const selectedKey = "selected-reference-set";
const chat = (id: number) => and(eq(conversationDataTable.conversation_id, id), eq(conversationDataTable.namespace, PAINTING_NAMESPACE));
const row = (id: number, key: string) => and(chat(id), eq(conversationDataTable.key, key));

const storedSets = (db: ConversationDatabase, conversationId: number) =>
	db.select().from(conversationDataTable).where(and(chat(conversationId), like(conversationDataTable.key, `${prefix}%`))).all()
		.map(({ key, value }) => Value.Parse(referenceSet, { ...JSON.parse(value), id: key.slice(prefix.length) }))
		.sort((left, right) => left.name.localeCompare(right.name));

export function readReferenceSets(db: ConversationDatabase, conversationId: number) {
	const stored = storedSets(db, conversationId);
	const referenceSets = stored.length === 0 ? [initial] : stored;
	const selected = db.select().from(conversationDataTable).where(row(conversationId, selectedKey)).get();
	const chosen = referenceSets.find(({ id }) => selected !== undefined && id === JSON.parse(selected.value));
	return { referenceSets, referenceSetId: (chosen ?? referenceSets[0]!).id };
}

const setName = (name: string) => {
	if (!name.trim()) throw new InvalidConversationCommandError("Name the Reference Set.");
	return name.trim();
};

export function updateReferenceSets(db: ConversationDatabase, { conversationId, command }: { conversationId: number; command: ReferenceSetCommand }): void {
	const write = (key: string, data: string | Omit<ReferenceSet, "id">) => {
		const value = JSON.stringify(data);
		db.insert(conversationDataTable).values({ conversation_id: conversationId, namespace: PAINTING_NAMESPACE, key, value })
			.onConflictDoUpdate({ target: [conversationDataTable.conversation_id, conversationDataTable.namespace, conversationDataTable.key], set: { value } }).run();
	};
	const writeSet = ({ id, name, references }: ReferenceSet) => write(`${prefix}${id}`, { name, references });
	const stored = storedSets(db, conversationId);
	const sets = stored.length === 0 ? [initial] : stored;
	if (command.type === "create-reference-set" || command.type === "adopt-reference-set") {
		const name = setName(command.name);
		if (stored.length === 0) writeSet(initial);
		const existing = command.type === "adopt-reference-set" ? sets.find(({ references }) => references === command.references) : undefined;
		const id = existing?.id ?? Bun.randomUUIDv7();
		if (existing === undefined) writeSet({ id, name, references: command.references });
		write(selectedKey, id);
		return;
	}
	const set = sets.find(({ id }) => id === command.id);
	if (set === undefined) {
		if (command.type === "save-reference-set") return;
		throw new InvalidConversationCommandError("This Reference Set was deleted.");
	}
	switch (command.type) {
		case "select-reference-set": write(selectedKey, set.id); return;
		case "save-reference-set": writeSet({ ...set, references: command.references }); return;
		case "rename-reference-set": writeSet({ ...set, name: setName(command.name) }); return;
		case "delete-reference-set":
			if (sets.length === 1) throw new InvalidConversationCommandError("Keep at least one Reference Set.");
			db.delete(conversationDataTable).where(row(conversationId, `${prefix}${set.id}`)).run();
			write(selectedKey, readReferenceSets(db, conversationId).referenceSetId);
	}
}
