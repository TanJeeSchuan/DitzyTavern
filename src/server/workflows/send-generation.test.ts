import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { activeGenerationTable } from "../database/schema";
import { openDatabase } from "../database/database";
import { createConversationModule } from "../conversation";
import { createFakeModelClient } from "../model-client";
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
					.where(eq(activeGenerationTable.conversation_id, conversationId))
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

	test("terminal details retain stop, other, and length finish reasons", async () => {
		const completed = await sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: 0,
			content: "Complete this thought.",
			modelClient: createFakeModelClient(() => [
				{ type: "content", text: "Finished cleanly." },
				{ type: "finished", finishReason: "stop" },
			]),
		});
		const completedMessage = completed.conversation.messages.at(-1);
		const completedVariant = completedMessage?.variants[0];
		if (completedMessage === undefined || completedVariant === undefined) {
			throw new Error("Completed Variant missing.");
		}
		expect(createConversationModule(database).readVariantDetails(
			conversationId,
			completedMessage.id,
			completedVariant.id,
		)?.provenance).toMatchObject({
			status: "complete",
			finishReason: "stop",
			interruptionCause: null,
		});

		const other = await sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: completed.conversation.revision,
			content: "Use another terminal reason.",
			modelClient: createFakeModelClient(() => [
				{ type: "content", text: "Finished another way." },
				{ type: "finished", finishReason: "other" },
			]),
		});
		const otherMessage = other.conversation.messages.at(-1);
		const otherVariant = otherMessage?.variants[0];
		if (otherMessage === undefined || otherVariant === undefined) {
			throw new Error("Other-finished Variant missing.");
		}
		expect(createConversationModule(database).readVariantDetails(
			conversationId,
			otherMessage.id,
			otherVariant.id,
		)?.provenance).toMatchObject({
			status: "complete",
			finishReason: "other",
			interruptionCause: null,
		});

		const lengthLimited = await sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: other.conversation.revision,
			content: "Reach the output limit.",
			modelClient: createFakeModelClient(() => [
				{ type: "content", text: "The bounded output." },
				{ type: "finished", finishReason: "length" },
			]),
		});
		const lengthMessage = lengthLimited.conversation.messages.at(-1);
		const lengthVariant = lengthMessage?.variants[0];
		if (lengthMessage === undefined || lengthVariant === undefined) {
			throw new Error("Length-limited Variant missing.");
		}
		expect(createConversationModule(database).readVariantDetails(
			conversationId,
			lengthMessage.id,
			lengthVariant.id,
		)?.provenance).toMatchObject({
			status: "length-limited",
			finishReason: "length",
			interruptionCause: null,
		});
	});

	test("terminal details retain every normalized interruption cause", async () => {
		let expectedRevision = 0;
		for (const cause of ["provider", "inactivity", "cancelled", "transport", "protocol"] as const) {
			const interrupted = await sendThroughProvisionalTailGeneration(database, {
				conversationId,
				expectedRevision,
				content: `Exercise the ${cause} path.`,
				modelClient: createFakeModelClient(() => [
					{ type: "content", text: `Partial ${cause} output.` },
					{ type: "failed", kind: cause, message: `Safe ${cause} failure.` },
				]),
			});
			expectedRevision = interrupted.conversation.revision;
			const message = interrupted.conversation.messages.at(-1);
			const variant = message?.variants[0];
			if (message === undefined || variant === undefined) {
				throw new Error(`Interrupted ${cause} Variant missing.`);
			}
			expect(createConversationModule(database).readVariantDetails(
				conversationId,
				message.id,
				variant.id,
			)?.provenance).toMatchObject({
				status: "interrupted",
				finishReason: null,
				interruptionCause: cause,
			});
		}
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
			tokenEstimator: () => 40_000,
		})).rejects.toThrow();
		expect(contacted).toBe(false);
		expect(createConversationModule(database).getSnapshot(conversationId)?.messages).toHaveLength(0);
		expect(drizzle(database).select().from(activeGenerationTable).all()).toHaveLength(0);
	});

	test("persists the attempt's Effective Generation Settings so active inspection retains the Safety allowance", async () => {
		const conversation = createConversationModule(database);
		conversation.execute({
			conversationId,
			expectedRevision: 0,
			action: {
				type: "update-generation-settings",
				settings: {
					modelId: "inspection-model",
					temperature: 0.5,
					topP: null,
					frequencyPenalty: null,
					presencePenalty: null,
					contextLimit: 8192,
					responseBudget: 256,
					safetyAllowance: 777,
					siblingGenerationLimit: 4,
					continuationStrategy: "assistant-prefill",
					continuationInstruction: "Never used by this Tail attempt.",
					continuationPrefillSuffix: "\n",
					requestOverrides: {
						"chat-completions": { provider_extension: { enabled: true } },
						responses: { metadata: { unused: true } },
						"anthropic-messages": {},
					},
				},
			},
		});

		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let generationId: number | undefined;
		const generation = sendThroughProvisionalTailGeneration(database, {
			conversationId,
			expectedRevision: 1,
			content: "Guide the scene.",
			modelClient: createFakeModelClient(async () => {
				await pending;
				return "The scene shifts.";
			}),
			onAccepted: (accepted) => {
				generationId = accepted.generationId;
			},
		});

		// The workflow persisted the attempt's Effective Generation Settings at
		// acceptance: every participating value is retained (including the
		// Safety allowance), while the Continuation group has no applicable
		// operand for a Tail attempt. Active inspection re-exposes only safe
		// settings and never Request Overrides.
		const details = createConversationModule(database).readActiveGenerationDetails(
			conversationId,
			generationId ?? -1,
		);
		expect(details?.generationSettings).toMatchObject({
			modelId: "inspection-model",
			temperature: 0.5,
			topP: null,
			frequencyPenalty: null,
			presencePenalty: null,
			contextLimit: 8192,
			responseBudget: 256,
			safetyAllowance: 777,
			siblingGenerationLimit: null,
			continuationStrategy: null,
			continuationInstruction: null,
			continuationPrefillSuffix: null,
		});
		expect(details?.budget.safetyAllowance).toBe(777);

		release();
		await generation;
	});
});
