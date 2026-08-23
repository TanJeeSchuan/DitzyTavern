import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../database/database";
import {
	createConversationModule,
	ConversationNotPlayableError,
	ConversationNotFoundError,
	InvalidConversationCommandError,
	StaleConversationRevisionError,
} from ".";

describe("Conversation module", () => {
	let database: Database;
	let conversationId: number;
	let humanId: number;
	let modelId: number;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		const module = createConversationModule(database);
		const snapshot = module.create({
			name: "Test Conversation",
			participants: [
				{ definition: { name: "Writer", prompt: emptyPrompt(), openings: [] } },
				{
					definition: {
						name: "Maren",
						prompt: emptyPrompt(),
						openings: ["Greeting"],
					},
				},
			],
			control: { human: 0, model: 1 },
		});
		conversationId = snapshot.id;
		humanId = snapshot.cast[0]?.id ?? 0;
		modelId = snapshot.cast[1]?.id ?? 0;
	});

	const emptyPrompt = () => ({
		systemInstruction: "",
		identity: "",
		scenario: "",
		exampleDialogue: "",
		postHistoryInstruction: "",
	});

	afterEach(() => {
		database.close();
	});

	test("rejects a stale command from another browser view", () => {
		const firstBrowser = createConversationModule(database);
		const secondBrowser = createConversationModule(database);
		const firstSnapshot = firstBrowser.getSnapshot(conversationId);
		const secondSnapshot = secondBrowser.getSnapshot(conversationId);
		if (firstSnapshot === undefined || secondSnapshot === undefined) {
			throw new Error("Conversation snapshot missing.");
		}

		const updated = firstBrowser.execute({
			conversationId,
			expectedRevision: firstSnapshot.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T00:00:01Z",
				variantContents: ["First"],
				authorParticipantId: humanId,
			},
		});

		expect(updated.revision).toBe(1);
		expect(() =>
			secondBrowser.execute({
				conversationId,
				expectedRevision: secondSnapshot.revision,
				action: {
					type: "create-message",
					timestamp: "2026-08-20T00:00:02Z",
					variantContents: ["Stale"],
					authorParticipantId: humanId,
				},
			}),
		).toThrow(StaleConversationRevisionError);
		expect(secondBrowser.getSnapshot(conversationId)).toEqual(updated);
	});

	test("creates Messages with immutable Author Stamps captured server-side", () => {
		const conversation = createConversationModule(database);
		const created = conversation.execute({
			conversationId,
			expectedRevision: 0,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T00:00:02Z",
				variantContents: ["One", "Two", "Three"],
				selectedVariantIndex: 1,
				authorParticipantId: modelId,
			},
		});
		const message = created.messages.at(-1);
		expect(message?.author).toEqual({
			participantId: modelId,
			capturedName: "Maren",
			inCast: true,
		});

		const second = conversation.execute({
			conversationId,
			expectedRevision: created.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T00:00:01Z",
				variantContents: ["Later position"],
				authorParticipantId: humanId,
			},
		});
		// The greeting from creation occupies position 1.
		expect(second.messages.map((message) => message.position)).toEqual([1, 2, 3]);
		expect(second.messages.at(-1)?.author?.capturedName).toBe("Writer");
		expect(
			second.messages.at(-1)?.variants.map((variant) => variant.position),
		).toEqual([1]);
		expect(
			second.messages.at(-1)?.variants.filter((variant) => variant.selected),
		).toHaveLength(1);

		// Editing content preserves the stamp.
		if (message === undefined || message.variants[1] === undefined) {
			throw new Error("Created Variant missing.");
		}
		const edited = conversation.execute({
			conversationId,
			expectedRevision: second.revision,
			action: {
				type: "edit-variant",
				messageId: message.id,
				variantId: message.variants[1].id,
				content: "Rewritten prose",
			},
		});
		const editedMessage = edited.messages.find(
			(candidate) => candidate.id === message.id,
		);
		expect(editedMessage?.author).toEqual(message.author);
	});

	test("rejects authorship referencing a Participant outside the Conversation", () => {
		const other = createConversationModule(database).create({
			name: "Other Conversation",
			participants: [
				{ definition: { name: "A", prompt: emptyPrompt(), openings: [] } },
				{ definition: { name: "B", prompt: emptyPrompt(), openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const outsiderId = other.cast[0]?.id ?? 0;

		expect(() =>
			createConversationModule(database).execute({
				conversationId,
				expectedRevision: 0,
				action: {
					type: "create-message",
					timestamp: "2026-08-20T00:00:02Z",
					variantContents: ["One"],
					authorParticipantId: outsiderId,
				},
			}),
		).toThrow(InvalidConversationCommandError);
	});

	test("compacts Variant positions and selects a replacement after deletion", () => {
		const conversation = createConversationModule(database);
		const created = conversation.execute({
			conversationId,
			expectedRevision: 0,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T00:00:00Z",
				variantContents: ["One", "Two", "Three"],
				selectedVariantIndex: 1,
				authorParticipantId: modelId,
			},
		});
		const message = created.messages.at(-1);
		const selected = message?.variants[1];
		if (message === undefined || selected === undefined) {
			throw new Error("Created Message or Variant missing.");
		}

		const deleted = conversation.execute({
			conversationId,
			expectedRevision: created.revision,
			action: {
				type: "delete-variant",
				messageId: message.id,
				variantId: selected.id,
			},
		});
		const variants =
			deleted.messages.find((candidate) => candidate.id === message.id)?.variants ??
			[];

		expect(variants.map((variant) => variant.position)).toEqual([1, 2]);
		expect(variants.map((variant) => variant.content)).toEqual(["One", "Three"]);
		expect(variants.filter((variant) => variant.selected)).toHaveLength(1);
		expect(variants[0]?.selected).toBe(true);

		const withSibling = conversation.execute({
			conversationId,
			expectedRevision: deleted.revision,
			action: {
				type: "create-variant",
				messageId: message.id,
				content: "Four",
			},
		});
		expect(
			withSibling.messages.find((candidate) => candidate.id === message.id)
				?.variants.map((variant) => variant.position),
		).toEqual([1, 2, 3]);
		expect(
			withSibling.messages.find((candidate) => candidate.id === message.id)
				?.variants[2]?.selected,
		).toBe(true);
	});

	test("protects the final Variant without advancing the revision", () => {
		const conversation = createConversationModule(database);
		const created = conversation.execute({
			conversationId,
			expectedRevision: 0,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T00:00:00Z",
				variantContents: ["Only"],
				authorParticipantId: modelId,
			},
		});
		const message = created.messages.at(-1);
		const variant = message?.variants[0];
		if (message === undefined || variant === undefined) {
			throw new Error("Created Message or Variant missing.");
		}

		expect(() =>
			conversation.execute({
				conversationId,
				expectedRevision: created.revision,
				action: {
					type: "delete-variant",
					messageId: message.id,
					variantId: variant.id,
				},
			}),
		).toThrow(InvalidConversationCommandError);
		expect(conversation.getSnapshot(conversationId)?.revision).toBe(created.revision);
	});

	test("gates Compose and Swipe behind derived playability while edits stay available", () => {
		const module = createConversationModule(database);
		const incomplete = module.create({
			name: "Incomplete Import",
			messages: [
				{
					timestamp: "2026-08-20T10:00:00Z",
					variants: [
						{ content: "Preserved", timestamp: "2026-08-20T10:00:00Z", selected: true },
					],
				},
			],
		});
		const preservedMessage = incomplete.messages[0];
		const preservedVariant = preservedMessage?.variants[0];
		if (preservedMessage === undefined || preservedVariant === undefined) {
			throw new Error("Preserved Message or Variant missing.");
		}

		expect(incomplete.playable).toBe(false);

		for (const action of [
			{
				type: "create-message" as const,
				timestamp: "2026-08-20T11:00:00Z",
				variantContents: ["Composed"],
				authorParticipantId: 0,
			},
			{
				type: "create-variant" as const,
				messageId: preservedMessage.id,
				content: "Swiped",
			},
		]) {
			expect(() =>
				module.execute({
					conversationId: incomplete.id,
					expectedRevision: incomplete.revision,
					action,
				}),
			).toThrow(ConversationNotPlayableError);
		}

		// Reads, edits, selection, and configuration remain available.
		const edited = module.execute({
			conversationId: incomplete.id,
			expectedRevision: incomplete.revision,
			action: {
				type: "edit-variant",
				messageId: preservedMessage.id,
				variantId: preservedVariant.id,
				content: "Edited preservation",
			},
		});
		expect(edited.messages[0]?.variants[0]?.content).toBe("Edited preservation");
	});

	test("owns scoped data and cascades Message deletion", () => {
		const conversation = createConversationModule(database);
		const created = conversation.execute({
			conversationId,
			expectedRevision: 0,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T00:00:00Z",
				variantContents: ["One"],
				authorParticipantId: modelId,
			},
		});
		const message = created.messages.at(-1);
		const variant = message?.variants[0];
		if (message === undefined || variant === undefined) {
			throw new Error("Created Message or Variant missing.");
		}

		const withData = conversation.execute({
			conversationId,
			expectedRevision: created.revision,
			action: {
				type: "put-data",
				scope: { type: "variant", messageId: message.id, variantId: variant.id },
				namespace: "test",
				key: "outcome",
				value: "complete",
			},
		});
		const dataMessage = withData.messages.find(
			(candidate) => candidate.id === message.id,
		);
		expect(dataMessage?.variants[0]?.data).toEqual([
			{ namespace: "test", key: "outcome", value: "complete" },
		]);

		const deleted = conversation.execute({
			conversationId,
			expectedRevision: withData.revision,
			action: { type: "delete-message", messageId: message.id },
		});
		expect(deleted.messages.map((candidate) => candidate.id)).not.toContain(
			message.id,
		);
	});

	test("keeps the greeting's Author Stamp across Variant selection and sibling creation", () => {
		const conversation = createConversationModule(database);
		const snapshot = conversation.getSnapshot(conversationId);
		if (snapshot === undefined) throw new Error("Snapshot missing.");
		const greeting = snapshot.messages[0];
		const variant = greeting?.variants[0];
		if (greeting === undefined || variant === undefined) {
			throw new Error("Greeting missing.");
		}
		const originalAuthor = greeting.author;

		const afterSelect = conversation.execute({
			conversationId,
			expectedRevision: snapshot.revision,
			action: {
				type: "select-variant",
				messageId: greeting.id,
				variantId: variant.id,
			},
		});
		expect(
			afterSelect.messages.find((candidate) => candidate.id === greeting.id)?.author,
		).toEqual(originalAuthor);

		const afterSibling = conversation.execute({
			conversationId,
			expectedRevision: afterSelect.revision,
			action: {
				type: "create-variant",
				messageId: greeting.id,
				content: "Another opening alternative",
			},
		});
		expect(
			afterSibling.messages.find((candidate) => candidate.id === greeting.id)?.author,
		).toEqual(originalAuthor);
	});

	describe("commitGeneration", () => {
		const capturedInput = (conversationId: number) => ({
			conversationId,
			timestamp: "2026-08-20T12:00:00Z",
			content: "The lantern answers.",
			authorParticipantId: modelId,
			capturedAuthorName: "Maren",
			humanParticipantId: humanId,
			modelParticipantId: modelId,
		});

		test("persists the Message with the captured Author Stamp and historical pair", () => {
			const conversation = createConversationModule(database);
			const committed = conversation.commitGeneration(capturedInput(conversationId));

			const message = committed.messages.at(-1);
			expect(message?.author).toEqual({
				participantId: modelId,
				capturedName: "Maren",
				inCast: true,
			});
			expect(message?.historicalContext).toEqual({
				humanParticipantId: humanId,
				modelParticipantId: modelId,
			});
			expect(message?.variants).toEqual([
				expect.objectContaining({ content: "The lantern answers.", selected: true }),
			]);
			expect(committed.revision).toBe(1);
		});

		test("requires the author to be the model Participant of the captured pair", () => {
			expect(() =>
				createConversationModule(database).commitGeneration({
					...capturedInput(conversationId),
					authorParticipantId: humanId,
				}),
			).toThrow(InvalidConversationCommandError);
			expect(createConversationModule(database).getSnapshot(conversationId)?.revision).toBe(0);
		});

		test("requires distinct captured human and model Participants", () => {
			expect(() =>
				createConversationModule(database).commitGeneration({
					...capturedInput(conversationId),
					humanParticipantId: modelId,
				}),
			).toThrow(InvalidConversationCommandError);
		});

		test("rejects pairs referencing Participants outside the Conversation", () => {
			const other = createConversationModule(database).create({
				name: "Other Conversation",
				participants: [
					{ definition: { name: "A", prompt: emptyPrompt(), openings: [] } },
					{ definition: { name: "B", prompt: emptyPrompt(), openings: [] } },
				],
				control: { human: 0, model: 1 },
			});
			const outsiderId = other.cast[0]?.id ?? 0;

			expect(() =>
				createConversationModule(database).commitGeneration({
					...capturedInput(conversationId),
					humanParticipantId: outsiderId,
				}),
			).toThrow(InvalidConversationCommandError);
		});

		test("rejects a missing Conversation with the typed not-found result", () => {
			expect(() =>
				createConversationModule(database).commitGeneration(
					capturedInput(424242),
				),
			).toThrow(ConversationNotFoundError);
		});
	});
});
