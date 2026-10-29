import type { ForkConversationAction } from "../../../shared/contract/conversation-schema";
import type { Database } from "bun:sqlite";
import { Type, type TSchema } from "@sinclair/typebox";
import { and, asc, eq } from "drizzle-orm";
import { boxDescriptors, boxIdOf } from "../../../shared/contract/box";
import { boxRecordSlot } from "../../../shared/contract/box-digest";
import { boxMoves, type BoxMoves } from "../../../shared/contract/box-generation";
import { isImportOwnedDataNamespace } from "../../../shared/import-data";
import { variantDataCodecs } from "../../../shared/variant-data-codecs";
import { rewriteRowReferences, type RowIdMaps } from "../../box/row-references";
import { serverBox } from "../../box/registry";
import { parseStoredBoxJson } from "../../box/stored-json";
import { authorRoleOf } from "../continuation";
import { InvalidConversationCommandError } from "../errors";
import { hasActiveGenerationFromConnection, readControlAssignment, requireConversationRevision } from "../internal";
import { toHistoricalContext } from "../message-read-projection";
import { requireConversationSummary, runConversationTransaction } from "./transaction";
import {
	conversationTable, conversationControlTable, conversationDataTable, conversationGenerationSettingsTable,
	conversationLorebookAttachmentTable, conversationLoreSettingsTable, conversationPromptPresetTable,
	messageTable, messageVariantTable, messageDataTable, messageVariantDataTable,
	participantTable, participantPromptTable, participantOpeningTable, participantDataTable, participantLorebookAttachmentTable,
} from "../../database/schema";

export function forkConversation(database: Database, input: Omit<ForkConversationAction, "type"> & { conversationId: number; expectedRevision: number }) {
	return runConversationTransaction(database, (db) => {
		requireConversationRevision(db, input.conversationId, input.expectedRevision, "conversation");
		const source = db.select().from(conversationTable).where(eq(conversationTable.id, input.conversationId)).get()!;
		if (hasActiveGenerationFromConnection(db, input.conversationId)) throw new InvalidConversationCommandError("Cannot fork while an Active Generation exists.");
		if (!input.name.trim()) throw new InvalidConversationCommandError("A Chat name cannot be blank.");
		const pointId = "rewind" in input.at ? input.at.rewind : input.at.through;
		const point = db.select().from(messageTable).where(and(eq(messageTable.conversation_id, input.conversationId), eq(messageTable.id, pointId))).get();
		if (!point) throw new InvalidConversationCommandError("The fork point is not a Message in this Chat.");
		const pointVariants = db.select().from(messageVariantTable).where(eq(messageVariantTable.message_id, point.id)).all();
		const variantId = "through" in input.at ? input.at.variantId : undefined;
		const selected = variantId !== undefined ? pointVariants.find((v) => v.id === variantId) : pointVariants.find((v) => v.selected);
		if (!selected) throw new InvalidConversationCommandError("The selected Variant is not on the fork point.");
		if ("rewind" in input.at && authorRoleOf({ author: { participantId: point.author_participant_id }, historicalContext: toHistoricalContext(point) }, readControlAssignment(db, input.conversationId)) !== "human") throw new InvalidConversationCommandError("Only a Human-authored Message can be rewound.");

		const fork = db.insert(conversationTable).values({ name: input.name.trim(), creation_time: new Date().toISOString(), last_message_time: point.timestamp, background_hash: source.background_hash, forked_from_conversation_id: input.conversationId, forked_from_message_id: point.id }).returning().get();
		const participantMap = new Map<number, number>(), messageMap = new Map<number, number>(), variantMap = new Map<number, number>();
		const maps: RowIdMaps = { participant: participantMap, message: messageMap, variant: variantMap };
		const participants = db.select().from(participantTable).where(eq(participantTable.conversation_id, input.conversationId)).all();
		for (const { id, ...row } of participants) participantMap.set(id, db.insert(participantTable).values({ ...row, conversation_id: fork.id }).returning({ id: participantTable.id }).get().id);
		const remap = (id: number | null) => id === null ? null : participantMap.get(id)!;
		for (const participant of participants) {
			const id = participantMap.get(participant.id)!;
			const prompt = db.select().from(participantPromptTable).where(eq(participantPromptTable.participant_id, participant.id)).get();
			if (prompt) db.insert(participantPromptTable).values({ ...prompt, participant_id: id }).run();
			for (const { id: _, ...row } of db.select().from(participantOpeningTable).where(eq(participantOpeningTable.participant_id, participant.id)).all()) db.insert(participantOpeningTable).values({ ...row, participant_id: id }).run();
			for (const { id: _, ...row } of db.select().from(participantLorebookAttachmentTable).where(eq(participantLorebookAttachmentTable.participant_id, participant.id)).all()) db.insert(participantLorebookAttachmentTable).values({ ...row, participant_id: id }).run();
		}
		for (const row of db.select().from(conversationControlTable).where(eq(conversationControlTable.conversation_id, input.conversationId)).all()) db.insert(conversationControlTable).values({ ...row, conversation_id: fork.id, participant_id: participantMap.get(row.participant_id)! }).run();
		const messages = db.select().from(messageTable).where(eq(messageTable.conversation_id, input.conversationId)).orderBy(asc(messageTable.position)).all().filter((m) => "rewind" in input.at ? m.position < point.position : m.position <= point.position);
		for (const { id, ...row } of messages) {
			const newId = db.insert(messageTable).values({ ...row, conversation_id: fork.id, author_participant_id: remap(row.author_participant_id), context_human_participant_id: remap(row.context_human_participant_id), context_model_participant_id: remap(row.context_model_participant_id) }).returning({ id: messageTable.id }).get().id;
			messageMap.set(id, newId);
			const variants = db.select().from(messageVariantTable).where(eq(messageVariantTable.message_id, id)).orderBy(asc(messageVariantTable.position)).all();
			for (const { id: variantId, ...variant } of variants) {
				const isSelected = id === point.id ? variantId === selected.id : variant.selected;
				if (input.trimVariants && !isSelected) continue;
				const copied = db.insert(messageVariantTable).values({ ...variant, message_id: newId, selected: isSelected, position: input.trimVariants ? 1 : variant.position }).returning({ id: messageVariantTable.id }).get();
				variantMap.set(variantId, copied.id);
			}
		}
		const omitted = new Set<string>();
		const descriptors = boxDescriptors();
		const rewrite = (id: string, schema: TSchema | undefined, value: string, place: string, keepMissing = false): string => {
			if (!schema) throw new InvalidConversationCommandError(`The ${id} Box has no schema for ${place}.`);
			try { return JSON.stringify(rewriteRowReferences(schema, parseStoredBoxJson(value, schema, place), maps, { keepMissing })); }
			catch (error) { throw new InvalidConversationCommandError(`The ${id} Box at ${place}: ${error instanceof Error ? error.message : String(error)}`); }
		};
		const boxValue = (namespace: string, key: string, value: string, scope: "chat" | "participant" | "message" | "variant"): string | undefined => {
			const id = boxIdOf(namespace);
			if (id === undefined) return isImportOwnedDataNamespace(namespace) ? undefined : value;
			const descriptor = descriptors.get(id);
			if (!descriptor) { omitted.add(id); return undefined; }
			if (scope === "chat" && (key === "enabled" || key === "instance")) return value;
			const schema = scope === "chat" ? key === "setup" ? descriptor.setup?.schema : descriptor.values?.chat?.[key]
				: scope === "participant" ? descriptor.values?.participant?.[key]
				: scope === "message" ? key === "moves" && descriptor.moves ? Type.Array(descriptor.moves.schema) : undefined
				: key.startsWith("record:") && descriptor.record ? boxRecordSlot(descriptor.record) : undefined;
			return rewrite(id, schema || undefined, value, `${scope}/${key}`);
		};
		for (const row of db.select().from(conversationDataTable).where(eq(conversationDataTable.conversation_id, input.conversationId)).all()) {
			const value = boxValue(row.namespace, row.key, row.value, "chat");
			if (value !== undefined) db.insert(conversationDataTable).values({ ...row, id: undefined, conversation_id: fork.id, value }).run();
		}
		for (const participant of participants) for (const row of db.select().from(participantDataTable).where(eq(participantDataTable.participant_id, participant.id)).all()) {
			const value = boxValue(row.namespace, row.key, row.value, "participant");
			if (value !== undefined) db.insert(participantDataTable).values({ ...row, id: undefined, participant_id: participantMap.get(participant.id)!, value }).run();
		}
		const copyMessageDataAndReadMoves = (messageId: number): BoxMoves => {
			const result: BoxMoves = {};
			for (const row of db.select().from(messageDataTable).where(eq(messageDataTable.message_id, messageId)).all()) {
				const value = boxValue(row.namespace, row.key, row.value, "message");
				if (value === undefined) continue;
				const id = boxIdOf(row.namespace);
				if (id !== undefined && row.key === "moves") result[id] = parseStoredBoxJson(JSON.stringify({ [id]: JSON.parse(value) }), boxMoves, `moves/${id}`)[id]!;
				const newId = messageMap.get(messageId);
				if (newId !== undefined) db.insert(messageDataTable).values({ ...row, id: undefined, message_id: newId, value }).run();
			}
			return result;
		};
		for (const message of messages) copyMessageDataAndReadMoves(message.id);
		for (const [oldId, newId] of variantMap) for (const row of db.select().from(messageVariantDataTable).where(eq(messageVariantDataTable.message_variant_id, oldId)).all()) {
			let value = boxValue(row.namespace, row.key, row.value, "variant");
			if (row.namespace === variantDataCodecs.boxTraces.namespace && row.key === variantDataCodecs.boxTraces.key) {
				const traces = variantDataCodecs.boxTraces.decode(row.value);
				for (const [reference, entry] of Object.entries(traces)) {
					const id = boxIdOf(reference);
					if (id === undefined || !descriptors.has(id)) { if (id !== undefined) omitted.add(id); delete traces[reference]; continue; }
					const schema = serverBox(id)?.advance?.trace;
				if (entry.trace !== undefined) entry.trace = JSON.parse(rewrite(id, schema, JSON.stringify(entry.trace), `trace/${reference}`, true));
				}
				value = JSON.stringify(traces);
			}
			if (value !== undefined) db.insert(messageVariantDataTable).values({ ...row, id: undefined, message_variant_id: newId, value }).run();
		}
		const settings = db.select().from(conversationGenerationSettingsTable).where(eq(conversationGenerationSettingsTable.conversation_id, input.conversationId)).get();
		if (settings) db.insert(conversationGenerationSettingsTable).values({ ...settings, conversation_id: fork.id }).run();
		const preset = db.select().from(conversationPromptPresetTable).where(eq(conversationPromptPresetTable.conversation_id, input.conversationId)).get();
		if (preset) db.insert(conversationPromptPresetTable).values({ ...preset, conversation_id: fork.id }).run();
		const lore = db.select().from(conversationLoreSettingsTable).where(eq(conversationLoreSettingsTable.conversation_id, input.conversationId)).get();
		if (lore) db.insert(conversationLoreSettingsTable).values({ ...lore, conversation_id: fork.id }).run();
		for (const { id: _, ...row } of db.select().from(conversationLorebookAttachmentTable).where(eq(conversationLorebookAttachmentTable.conversation_id, input.conversationId)).all()) db.insert(conversationLorebookAttachmentTable).values({ ...row, conversation_id: fork.id }).run();
		const rewind = "rewind" in input.at ? { content: selected.content, moves: copyMessageDataAndReadMoves(point.id) } : undefined;
		return { conversation: requireConversationSummary(db, fork.id), omittedBoxes: [...omitted].sort(), rewind };
	});
}
