import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { openDatabase } from "../database/database";
import { conversationGenerationSettingsTable } from "../database/schema";
import {
	ARCHIVE_KEY,
	ARCHIVE_NAMESPACE,
	IMPORTER_VERSION,
	IMPORT_KEYS,
	IMPORT_NAMESPACE,
	VARIANT_KEYS,
} from "../sillytavern/adapter/types";
import {
	createConversationModule,
	ConversationNotPlayableError,
	ConversationNotFoundError,
	InvalidConversationCommandError,
	StaleConversationRevisionError,
	type AcceptContinuationGenerationInput,
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

	test("keeps generation-settings reads pure when the backing row is absent", () => {
		const db = drizzle(database);
		db.delete(conversationGenerationSettingsTable).run();

		const settings = createConversationModule(database).getGenerationSettings(conversationId);

		expect(settings).toBeUndefined();
		expect(db.select().from(conversationGenerationSettingsTable).all()).toHaveLength(0);
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

		expect(preservedMessage.author).toBeNull();
		expect(preservedMessage.historicalContext).toBeNull();
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

	// Import provenance is server-owned (ADR-0028): it is written through
	// the creation seam exactly as the Import Projection writes it and can
	// never be rewritten or removed through the generic data commands.
	test("keeps import-owned provenance beyond generic data commands", () => {
		const conversation = createConversationModule(database);
		const reportJson = JSON.stringify({
			importerVersion: IMPORTER_VERSION,
			source: { filename: "chat.jsonl", sha256: "a".repeat(64) },
			counts: { messages: 1, variants: 1 },
			warnings: [],
		});
		const imported = conversation.create({
			name: "Imported Conversation",
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
			data: [
				{
					namespace: IMPORT_NAMESPACE,
					key: IMPORT_KEYS.reportJson,
					value: reportJson,
				},
				{
					namespace: IMPORT_NAMESPACE,
					key: IMPORT_KEYS.warnings,
					value: "[]",
				},
				{
					namespace: ARCHIVE_NAMESPACE,
					key: ARCHIVE_KEY,
					value: "{}",
				},
			],
		});
		const greeting = imported.messages[0];
		const greetingVariant = greeting?.variants[0];
		if (greeting === undefined || greetingVariant === undefined) {
			throw new Error("Imported Conversation greeting missing.");
		}

		// A generic put-data addressing the import namespace is rejected, in
		// every scope: the Conversation receipt, warnings, and the promoted
		// per-Variant provenance are not client-writable.
		expect(() =>
			conversation.execute({
				conversationId: imported.id,
				expectedRevision: imported.revision,
				action: {
					type: "put-data",
					scope: { type: "conversation" },
					namespace: IMPORT_NAMESPACE,
					key: IMPORT_KEYS.warnings,
					value: '["forged warning"]',
				},
			}),
		).toThrow(InvalidConversationCommandError);
		expect(() =>
			conversation.execute({
				conversationId: imported.id,
				expectedRevision: imported.revision,
				action: {
					type: "put-data",
					scope: {
						type: "variant",
						messageId: greeting.id,
						variantId: greetingVariant.id,
					},
					namespace: IMPORT_NAMESPACE,
					key: VARIANT_KEYS.swipeIndex,
					value: "7",
				},
			}),
		).toThrow(InvalidConversationCommandError);

		// Deletion of import provenance is equally out of reach, in every
		// scope.
		expect(() =>
			conversation.execute({
				conversationId: imported.id,
				expectedRevision: imported.revision,
				action: {
					type: "delete-data",
					scope: { type: "conversation" },
					namespace: IMPORT_NAMESPACE,
					key: IMPORT_KEYS.warnings,
				},
			}),
		).toThrow(InvalidConversationCommandError);
		expect(() =>
			conversation.execute({
				conversationId: imported.id,
				expectedRevision: imported.revision,
				action: {
					type: "put-data",
					scope: { type: "message", messageId: greeting.id },
					namespace: IMPORT_NAMESPACE,
					key: IMPORT_KEYS.authorName,
					value: "Forged Author",
				},
			}),
		).toThrow(InvalidConversationCommandError);
		expect(() =>
			conversation.execute({
				conversationId: imported.id,
				expectedRevision: imported.revision,
				action: {
					type: "delete-data",
					scope: { type: "message", messageId: greeting.id },
					namespace: IMPORT_NAMESPACE,
					key: IMPORT_KEYS.authorName,
				},
			}),
		).toThrow(InvalidConversationCommandError);
		// The Canonical Source Archive is import-owned provenance too: no
		// generic rewrite of the preserved source values.
		expect(() =>
			conversation.execute({
				conversationId: imported.id,
				expectedRevision: imported.revision,
				action: {
					type: "put-data",
					scope: { type: "conversation" },
					namespace: ARCHIVE_NAMESPACE,
					key: ARCHIVE_KEY,
					value: '{"forged":true}',
				},
			}),
		).toThrow(InvalidConversationCommandError);

		// The reservation is exact-match, not prefix-based: a namespace that
		// merely extends an import-owned one stays generic.
		const nearMiss = conversation.execute({
			conversationId: imported.id,
			expectedRevision: imported.revision,
			action: {
				type: "put-data",
				scope: { type: "conversation" },
				namespace: "import.sillytavernX",
				key: "key",
				value: "value",
			},
		});
		// The successful generic write advances the revision; the rejected
		// import-namespace attempts did not.
		expect(nearMiss.revision).toBe(imported.revision + 1);

		// The rejected commands left the persisted provenance intact and did
		// not advance the revision, so the next ordinary command still
		// applies.
		const provenance = conversation.readConversationData(imported.id, {
			namespace: IMPORT_NAMESPACE,
		});
		expect(provenance?.entries).toEqual([
			{
				namespace: IMPORT_NAMESPACE,
				key: IMPORT_KEYS.reportJson,
				value: reportJson,
			},
			{
				namespace: IMPORT_NAMESPACE,
				key: IMPORT_KEYS.warnings,
				value: "[]",
			},
		]);
		const afterRejections = conversation.execute({
			conversationId: imported.id,
			expectedRevision: nearMiss.revision,
			action: {
				type: "put-data",
				scope: { type: "conversation" },
				namespace: "test",
				key: "outcome",
				value: "complete",
			},
		});
		expect(afterRejections.revision).toBe(nearMiss.revision + 1);
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

	// Terminal Generation persistence is exercised through the production
	// Continuation lifecycle: acceptance creates the provisional model
	// target, resolution commits its terminal Variant.
	describe("Continuation acceptance and resolution", () => {
		const accept = (
			module: ReturnType<typeof createConversationModule>,
			overrides: Partial<AcceptContinuationGenerationInput> = {},
		) => {
			const snapshot = module.getSnapshot(conversationId);
			if (snapshot === undefined) throw new Error("Snapshot missing.");
			const greeting = snapshot.messages[0];
			const greetingVariant = greeting?.variants[0];
			if (greeting === undefined || greetingVariant === undefined) {
				throw new Error("Greeting missing.");
			}
			return module.acceptContinuationGeneration({
				conversationId,
				expectedRevision: snapshot.revision,
				timestamp: "2026-08-20T12:00:00Z",
				precedingMessageId: greeting.id,
				precedingVariantId: greetingVariant.id,
				humanParticipantId: humanId,
				modelParticipantId: modelId,
				capturedHumanName: "Writer",
				capturedModelName: "Maren",
				promptPlan: {},
				historyRoles: [],
				generationSettings: {},
				connection: {},
				...overrides,
			});
		};

		const resolve = (
			module: ReturnType<typeof createConversationModule>,
			generationId: number,
		) =>
			module.resolveGeneration({
				conversationId,
				generationId,
				timestamp: "2026-08-20T12:00:00Z",
				content: "The lantern answers.",
			});

		test("persists the terminal Message with the Author Stamp and historical pair through acceptance and resolution", () => {
			const conversation = createConversationModule(database);
			const accepted = accept(conversation);
			const committed = resolve(conversation, accepted.generationId);

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
			// Acceptance and resolution each advance the revision exactly once.
			expect(committed.revision).toBe(2);
		});

		test("requires distinct captured human and model Participants", () => {
			const conversation = createConversationModule(database);
			expect(() =>
				accept(conversation, { humanParticipantId: modelId }),
			).toThrow(InvalidConversationCommandError);
			expect(conversation.getSnapshot(conversationId)?.revision).toBe(0);
		});

		test("rejects a captured pair that is no longer authoritative", () => {
			const conversation = createConversationModule(database);
			expect(() =>
				accept(conversation, { modelParticipantId: humanId }),
			).toThrow(InvalidConversationCommandError);
			expect(conversation.getSnapshot(conversationId)?.revision).toBe(0);
		});

		test("rejects a captured model stamp that no longer matches the model Participant", () => {
			const conversation = createConversationModule(database);
			expect(() =>
				accept(conversation, { capturedModelName: "Renamed Elsewhere" }),
			).toThrow(InvalidConversationCommandError);
			expect(conversation.getSnapshot(conversationId)?.revision).toBe(0);
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
			const conversation = createConversationModule(database);

			expect(() =>
				accept(conversation, { humanParticipantId: outsiderId }),
			).toThrow(InvalidConversationCommandError);
		});

		test("rejects a missing Conversation with the typed not-found result", () => {
			const conversation = createConversationModule(database);
			expect(() =>
				accept(conversation, { conversationId: 424242 }),
			).toThrow(ConversationNotFoundError);
		});
	});
});
