import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openInitializedDatabase } from "../database/database";
import { messageTable, participantTable } from "../database/schema";
import { createConversationRoutes } from "../contract/conversation";
import {
	acceptConversationTailGeneration,
	ConversationNotFoundError,
	createConversationModule,
	deleteConversation,
	InvalidConversationCommandError,
	StaleConversationRevisionError,
	type ConversationModule,
	type ConversationSnapshot,
} from ".";
import { applyCommand } from "./test-fixtures";

import { observeConversationWrites } from "./commands/transaction";
import { syncMemorySources } from "../memory";
const prompt = {
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
};

describe("Chat rename and deletion", () => {
	let database: Database;
	let module: ConversationModule;

	beforeEach(() => {
		database = openInitializedDatabase({ path: ":memory:" });
		observeConversationWrites(database, syncMemorySources);
		module = createConversationModule(database);
	});
	afterEach(() => database.close());

	const createChat = (name: string) =>
		module.create({
			name,
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: ["The lamp turns."] } },
			],
			control: { human: 0, model: 1 },
		});

	const rename = (chat: ConversationSnapshot, name: string) =>
		applyCommand(module, { conversationId: chat.id, expectedRevision: chat.revision, action: { type: "rename-conversation", name } });

	test("rename stores the trimmed name and advances the revision", () => {
		const chat = createChat("rescue-1789004168594");

		const renamed = rename(chat, "  Coastal Ride  ");

		expect(renamed.name).toBe("Coastal Ride");
		expect(renamed.revision).toBe(chat.revision + 1);
		expect(module.getSnapshot(chat.id)?.name).toBe("Coastal Ride");
	});

	test("rename rejects a blank name and a stale revision without changing the Chat", () => {
		const chat = createChat("Lantern House");
		const renamed = rename(chat, "Lantern Hall");

		expect(() => rename(renamed, "   ")).toThrow(InvalidConversationCommandError);
		expect(() => rename(chat, "Stale Name")).toThrow(StaleConversationRevisionError);
		expect(module.getSnapshot(chat.id)?.name).toBe("Lantern Hall");
	});

	test("deleting a Chat with authored history, including a tombstoned Participant, removes only that Chat", () => {
		const doomed = createChat("Doomed");
		const kept = createChat("Kept");
		const writerId = doomed.cast[0]?.id ?? 0;
		const composed = applyCommand(module, {
			conversationId: doomed.id,
			expectedRevision: doomed.revision,
			action: { type: "create-message", timestamp: "2026-09-26T10:00:00Z", variantContents: ["First", "Second"], authorParticipantId: writerId },
		});
		const withThird = applyCommand(module, {
			conversationId: doomed.id,
			expectedRevision: composed.revision,
			action: { type: "add-participant", definition: { name: "Juno", prompt, openings: [] } },
		});
		const reseated = applyCommand(module, {
			conversationId: doomed.id,
			expectedRevision: withThird.revision,
			action: { type: "assign-control", seat: "human", participantId: withThird.cast[2]?.id ?? 0 },
		});
		applyCommand(module, {
			conversationId: doomed.id,
			expectedRevision: reseated.revision,
			action: { type: "remove-participant", participantId: writerId },
		});

		deleteConversation(database, doomed.id);

		const db = drizzle(database);
		expect(module.getSnapshot(doomed.id)).toBeUndefined();
		expect(db.select().from(messageTable).where(eq(messageTable.conversation_id, doomed.id)).all()).toEqual([]);
		expect(db.select().from(participantTable).where(eq(participantTable.conversation_id, doomed.id)).all()).toEqual([]);
		expect(module.getSnapshot(kept.id)?.cast.map((participant) => participant.name)).toEqual(["Writer", "Maren"]);
	});

	test("deletion refuses an unknown Chat and a Chat with an Active Generation", () => {
		const chat = createChat("Generating");
		const [human, model] = chat.cast;
		if (human === undefined || model === undefined) throw new Error("Control Participants missing.");
		acceptConversationTailGeneration(database, {
			conversationId: chat.id,
			expectedRevision: chat.revision,
			timestamp: "2026-09-26T10:00:00.000Z",
			humanContent: "Keep going.",
			humanParticipantId: human.id,
			modelParticipantId: model.id,
			capturedModelName: model.name,
			promptPlan: { blocks: [], warnings: [], images: [] },
			promptContext: [],
			generationSettings: {},
			connection: {},
		});

		expect(() => deleteConversation(database, chat.id + 100)).toThrow(ConversationNotFoundError);
		expect(() => deleteConversation(database, chat.id)).toThrow(InvalidConversationCommandError);
		expect(module.getSnapshot(chat.id)).toBeDefined();
	});

	test("the delete route answers deleted, not-found, and invalid outcomes", async () => {
		const app = createConversationRoutes(database);
		const idle = createChat("Idle");
		const busy = createChat("Busy");
		const [human, model] = busy.cast;
		if (human === undefined || model === undefined) throw new Error("Control Participants missing.");
		acceptConversationTailGeneration(database, {
			conversationId: busy.id,
			expectedRevision: busy.revision,
			timestamp: "2026-09-26T10:00:00.000Z",
			humanContent: "Keep going.",
			humanParticipantId: human.id,
			modelParticipantId: model.id,
			capturedModelName: model.name,
			promptPlan: { blocks: [], warnings: [], images: [] },
			promptContext: [],
			generationSettings: {},
			connection: {},
		});
		const remove = (id: number) => app.handle(new Request(`http://localhost/api/conversations/${id}`, { method: "DELETE" }));

		const deleted = await remove(idle.id);
		const missing = await remove(idle.id);
		const refused = await remove(busy.id);

		expect([deleted.status, await deleted.json()]).toEqual([200, { outcome: "deleted" }]);
		expect([missing.status, await missing.json()]).toEqual([404, { outcome: "not-found" }]);
		expect(refused.status).toBe(422);
		expect(await refused.json()).toEqual({ outcome: "invalid", reason: "Stop the running Generation before deleting this Chat." });
	});
});
