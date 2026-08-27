import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { activeGenerationTable } from "../database/schema";
import { openDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import { createFakeModelClient } from "../model-client";
import { createTokenEstimator } from "../prompt-compiler";
import { sendThroughProvisionalTailGeneration } from ".";

const prompt = {
	systemInstruction: "Answer briefly.",
	identity: "I am {{self}}.",
	scenario: "The room is quiet.",
	exampleDialogue: "",
	postHistoryInstruction: "Continue.",
};

describe("Send through provisional Tail Generation", () => {
	let database: Database;
	let conversationId: number;
	let humanId: number;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		const created = createConversationModule(database).create({
			name: "Send Chat",
			participants: [
				{ definition: { name: "Writer", prompt, openings: [] } },
				{ definition: { name: "Maren", prompt, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		conversationId = created.id;
		humanId = created.cast[0]?.id ?? -1;
	});

	afterEach(() => database.close());

	test("accepts the human input and resolves the authoritative provisional target", async () => {
		let contactedWithActiveTarget = false;
		const result = await sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: 0,
			content: "Please open the door.",
			modelClient: createFakeModelClient(() => {
				contactedWithActiveTarget = drizzle(database)
					.select()
					.from(activeGenerationTable)
					.where(eq(activeGenerationTable.chat_id, conversationId))
					.all().length === 1;
				return "The door opens.";
			}),
		});

		expect(contactedWithActiveTarget).toBe(true);
		expect(result.conversation.messages.map((message) => message.author?.participantId)).toEqual([
			humanId,
			result.conversation.control.modelParticipantId,
		]);
		expect(result.conversation.messages[0]?.variants[0]?.content).toBe("Please open the door.");
		expect(result.conversation.messages[1]?.variants[0]?.content).toBe("The door opens.");
		expect(result.conversation.revision).toBe(2);
		expect(drizzle(database).select().from(activeGenerationTable).all()).toHaveLength(0);
	});

	test("removes zero-output targets while preserving the accepted human Message and reuses it on retry", async () => {
		await expect(sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: 0,
			content: "Please try again.",
			modelClient: createFakeModelClient(() => [
				{ type: "failed", kind: "provider", message: "No answer." },
			]),
		})).rejects.toThrow("No answer.");

		const afterFailure = createConversationModule(database).getSnapshot(conversationId);
		expect(afterFailure?.messages).toHaveLength(1);
		expect(afterFailure?.messages[0]?.author?.participantId).toBe(humanId);
		expect(afterFailure?.revision).toBe(2);

		const retried = await sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: afterFailure?.revision ?? -1,
			content: "Please try again.",
			modelClient: createFakeModelClient(() => "Now it works."),
		});
		expect(retried.conversation.messages).toHaveLength(2);
		expect(retried.conversation.messages[0]?.author?.participantId).toBe(humanId);
		expect(retried.conversation.messages[1]?.variants[0]?.content).toBe("Now it works.");
	});

	test("rejects an oversized candidate before any Message or Active Generation is persisted", async () => {
		let contacted = false;
		await expect(sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: 0,
			content: "Protected input.",
			modelClient: createFakeModelClient(() => {
				contacted = true;
				return "never";
			}),
			tokenEstimator: createTokenEstimator(() => 40_000),
		})).rejects.toThrow();
		expect(contacted).toBe(false);
		expect(createConversationModule(database).getSnapshot(conversationId)?.messages).toHaveLength(0);
		expect(drizzle(database).select().from(activeGenerationTable).all()).toHaveLength(0);
	});
});
