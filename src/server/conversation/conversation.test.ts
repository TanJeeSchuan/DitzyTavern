import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { chatTable } from "../database/schema";
import { openDatabase } from "../database/database";
import {
	createConversationModule,
	InvalidConversationCommandError,
	StaleConversationRevisionError,
} from ".";

describe("Conversation module", () => {
	let database: Database;
	let conversationId: number;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		conversationId = drizzle(database)
			.insert(chatTable)
			.values({
				name: "Test Conversation",
				creation_time: "2026-08-20T00:00:00Z",
				last_message_time: "2026-08-20T00:00:00Z",
			})
			.returning({ id: chatTable.id })
			.get().id;
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
				},
			}),
		).toThrow(StaleConversationRevisionError);
		expect(secondBrowser.getSnapshot(conversationId)).toEqual(updated);
	});

	test("creates Messages and Variants atomically in position order", () => {
		const conversation = createConversationModule(database);
		const first = conversation.execute({
			conversationId,
			expectedRevision: 0,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T00:00:02Z",
				variantContents: ["One", "Two", "Three"],
				selectedVariantIndex: 1,
			},
		});
		const second = conversation.execute({
			conversationId,
			expectedRevision: first.revision,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T00:00:01Z",
				variantContents: ["Later position"],
			},
		});

		expect(second.messages.map((message) => message.position)).toEqual([1, 2]);
		expect(second.messages[0]?.variants.map((variant) => variant.position)).toEqual([
			1, 2, 3,
		]);
		expect(
			second.messages[0]?.variants.filter((variant) => variant.selected),
		).toHaveLength(1);
		expect(second.messages[0]?.variants[1]?.selected).toBe(true);
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
			},
		});
		const message = created.messages[0];
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
		const variants = deleted.messages[0]?.variants ?? [];

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
		expect(withSibling.messages[0]?.variants.map((variant) => variant.position)).toEqual([
			1, 2, 3,
		]);
		expect(withSibling.messages[0]?.variants[2]?.selected).toBe(true);
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
			},
		});
		const message = created.messages[0];
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

	test("owns scoped data and cascades Message deletion", () => {
		const conversation = createConversationModule(database);
		const created = conversation.execute({
			conversationId,
			expectedRevision: 0,
			action: {
				type: "create-message",
				timestamp: "2026-08-20T00:00:00Z",
				variantContents: ["One"],
			},
		});
		const message = created.messages[0];
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
		expect(withData.messages[0]?.variants[0]?.data).toEqual([
			{ namespace: "test", key: "outcome", value: "complete" },
		]);

		const deleted = conversation.execute({
			conversationId,
			expectedRevision: withData.revision,
			action: { type: "delete-message", messageId: message.id },
		});
		expect(deleted.messages).toEqual([]);
	});
});
