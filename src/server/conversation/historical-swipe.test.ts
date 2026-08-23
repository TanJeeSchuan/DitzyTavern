import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { participantPromptTable } from "../database/schema";
import { openDatabase } from "../database/database";
import {
	createConversationModule,
	ConversationNotFoundError,
	InvalidConversationCommandError,
	SiblingVariantUnavailableError,
	type ConversationModule,
	type ConversationSnapshot,
	type ParticipantDefinition,
} from ".";

// Targeted Swipe (new sibling Variant) eligibility is derived per Message
// from its captured historical Control pair — never from current Control —
// and is surfaced on the snapshot with the typed reason for ineligibility.

const prompt = (
	overrides: Partial<ParticipantDefinition["prompt"]> = {},
): ParticipantDefinition["prompt"] => ({
	systemInstruction: "",
	identity: "I am {{self}}, speaking to {{other}}.",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
	...overrides,
});

const adHoc = (
	name: string,
	openings: readonly string[] = [],
	promptOverrides: Partial<ParticipantDefinition["prompt"]> = {},
): ParticipantDefinition => ({
	name,
	prompt: prompt(promptOverrides),
	openings,
});

const setup = (database: Database) => {
	const module = createConversationModule(database);
	const snapshot = module.create({
		name: "Swipe Chat",
		participants: [
			{ definition: adHoc("Writer") },
			{ definition: adHoc("Maren Voss", ["The lamp turns above you."]) },
		],
		control: { human: 0, model: 1 },
	});
	return {
		module,
		snapshot,
		humanId: snapshot.cast[0]?.id ?? 0,
		modelId: snapshot.cast[1]?.id ?? 0,
	};
};

const commitFor = (
	module: ConversationModule,
	snapshot: ConversationSnapshot,
	humanId: number,
	modelId: number,
	content: string,
	timestamp = "2026-08-20T13:00:00Z",
) =>
	module.commitGeneration({
		conversationId: snapshot.id,
		timestamp,
		content,
		authorParticipantId: modelId,
		capturedAuthorName: "Maren Voss",
		humanParticipantId: humanId,
		modelParticipantId: modelId,
	});

describe("Per-Message targeted Swipe eligibility", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});
	afterEach(() => {
		database.close();
	});

	test("configured opening and generated Messages are eligible from their captured historical pair", () => {
		const { module, snapshot, humanId, modelId } = setup(database);

		const greeting = snapshot.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");
		expect(greeting.historicalContext).toEqual({
			humanParticipantId: humanId,
			modelParticipantId: modelId,
		});
		expect(greeting.swipe).toEqual({ eligible: true, reason: null });

		const committed = commitFor(module, snapshot, humanId, modelId, "The fog answers.");
		const generated = committed.messages[1];
		expect(generated?.swipe).toEqual({ eligible: true, reason: null });
	});

	test("an imported Message without captured context is ineligible with the typed reason even in a playable Conversation", () => {
		const module = createConversationModule(database);
		const imported = module.create({
			name: "Mixed Chat",
			participants: [
				{ definition: adHoc("Writer") },
				{ definition: adHoc("Maren Voss") },
			],
			control: { human: 0, model: 1 },
			messages: [
				{
					timestamp: "2026-08-20T10:00:00Z",
					variants: [
						{
							content: "Preserved",
							timestamp: "2026-08-20T10:00:00Z",
							selected: true,
						},
					],
				},
			],
		});

		expect(imported.playable).toBe(true);
		expect(imported.messages[0]?.historicalContext).toBeNull();
		expect(imported.messages[0]?.swipe).toEqual({
			eligible: false,
			reason: "missing-historical-context",
		});
	});

	test("every Message in an incomplete Conversation is ineligible with the playability reason", () => {
		const module = createConversationModule(database);
		const incomplete = module.create({
			name: "Incomplete Import",
			messages: [
				{
					timestamp: "2026-08-20T10:00:00Z",
					variants: [
						{
							content: "Preserved",
							timestamp: "2026-08-20T10:00:00Z",
							selected: true,
						},
					],
				},
			],
		});

		expect(incomplete.playable).toBe(false);
		expect(incomplete.messages[0]?.swipe).toEqual({
			eligible: false,
			reason: "conversation-not-playable",
		});
	});

	test("a historical Participant that loses its Definition makes the target ineligible with the typed reason", () => {
		const { module, snapshot, humanId, modelId } = setup(database);
		const withJuno = module.execute({
			conversationId: snapshot.id,
			expectedRevision: snapshot.revision,
			action: { type: "add-participant", definition: adHoc("Juno Ashfeld") },
		});
		const junoId = withJuno.cast[2]?.id ?? 0;
		const swapped = module.execute({
			conversationId: snapshot.id,
			expectedRevision: withJuno.revision,
			action: { type: "assign-control", seat: "model", participantId: junoId },
		});
		expect(swapped.control.modelParticipantId).toBe(junoId);

		// The historical model Participant (Maren) is unseated; stripping its
		// Definition removes it from the derived Cast while the base row still
		// satisfies the structural reference from Message history.
		drizzle(database)
			.delete(participantPromptTable)
			.where(eq(participantPromptTable.participant_id, modelId))
			.run();

		const after = module.getSnapshot(snapshot.id);
		if (after === undefined) throw new Error("Snapshot missing.");
		expect(after.playable).toBe(true);
		expect(after.cast.find((participant) => participant.id === modelId)).toBeUndefined();
		expect(after.messages[0]?.swipe).toEqual({
			eligible: false,
			reason: "historical-participant-unavailable",
		});
		expect(after.cast.find((participant) => participant.id === humanId)).toBeDefined();
	});

	test("ineligible Messages keep their existing Variants selectable and editable", () => {
		const module = createConversationModule(database);
		const imported = module.create({
			name: "Mixed Chat",
			participants: [
				{ definition: adHoc("Writer") },
				{ definition: adHoc("Maren Voss") },
			],
			control: { human: 0, model: 1 },
			messages: [
				{
					timestamp: "2026-08-20T10:00:00Z",
					variants: [
						{
							content: "Preserved",
							timestamp: "2026-08-20T10:00:00Z",
							selected: true,
						},
					],
				},
			],
		});
		const message = imported.messages[0];
		const variant = message?.variants[0];
		if (message === undefined || variant === undefined) {
			throw new Error("Preserved Message or Variant missing.");
		}

		const edited = module.execute({
			conversationId: imported.id,
			expectedRevision: imported.revision,
			action: {
				type: "edit-variant",
				messageId: message.id,
				variantId: variant.id,
				content: "Edited preservation",
			},
		});
		expect(edited.messages[0]?.variants[0]?.content).toBe("Edited preservation");
		expect(
			module.execute({
				conversationId: imported.id,
				expectedRevision: edited.revision,
				action: {
					type: "select-variant",
					messageId: message.id,
					variantId: variant.id,
				},
			}).messages[0]?.swipe,
		).toEqual({ eligible: false, reason: "missing-historical-context" });
	});
});

describe("commitSiblingVariant", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});
	afterEach(() => {
		database.close();
	});

	const siblingInput = (conversationId: number, messageId: number) => ({
		conversationId,
		messageId,
		timestamp: "2026-08-20T14:00:00Z",
		content: "Another lamp turn.",
	});

	test("appends a selected sibling Variant without touching Control, the Author Stamp, or the Message timestamp", () => {
		const { module, snapshot, humanId, modelId } = setup(database);
		const greeting = snapshot.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");
		const originalAuthor = greeting.author;
		const originalControl = snapshot.control;

		const committed = module.commitSiblingVariant(
			siblingInput(snapshot.id, greeting.id),
		);

		const message = committed.messages.find(
			(candidate) => candidate.id === greeting.id,
		);
		expect(message?.variants.map((variant) => variant.position)).toEqual([1, 2]);
		expect(message?.variants.map((variant) => variant.content)).toEqual([
			"The lamp turns above you.",
			"Another lamp turn.",
		]);
		expect(message?.variants[1]?.selected).toBe(true);
		expect(message?.variants[0]?.selected).toBe(false);
		expect(message?.variants[1]?.timestamp).toBe("2026-08-20T14:00:00Z");
		expect(message?.author).toEqual(originalAuthor);
		expect(message?.historicalContext).toEqual({
			humanParticipantId: humanId,
			modelParticipantId: modelId,
		});
		expect(committed.control).toEqual(originalControl);
		expect(committed.messages.map((candidate) => candidate.id)).toEqual([
			greeting.id,
		]);
		expect(committed.revision).toBe(1);
	});

	test("keeps appending native-order siblings under one stamp and leaves current Control untouched after seats change", () => {
		const { module, snapshot, modelId } = setup(database);
		const greeting = snapshot.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");

		const withJuno = module.execute({
			conversationId: snapshot.id,
			expectedRevision: snapshot.revision,
			action: { type: "add-participant", definition: adHoc("Juno Ashfeld") },
		});
		const junoId = withJuno.cast[2]?.id ?? 0;
		const swapped = module.execute({
			conversationId: snapshot.id,
			expectedRevision: withJuno.revision,
			action: { type: "assign-control", seat: "model", participantId: junoId },
		});

		const first = module.commitSiblingVariant(
			siblingInput(snapshot.id, greeting.id),
		);
		const second = module.commitSiblingVariant({
			...siblingInput(snapshot.id, greeting.id),
			content: "A third alternative.",
		});

		const message = second.messages.find(
			(candidate) => candidate.id === greeting.id,
		);
		expect(message?.variants.map((variant) => variant.position)).toEqual([1, 2, 3]);
		expect(message?.variants[2]?.selected).toBe(true);
		expect(message?.author).toEqual(greeting.author);
		expect(message?.author?.participantId).toBe(modelId);
		expect(first.control).toEqual(swapped.control);
		expect(second.control).toEqual(swapped.control);
	});

	test("concurrent edits advancing the revision do not block the sibling commit", () => {
		const { module, snapshot } = setup(database);
		const greeting = snapshot.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");

		const edited = module.execute({
			conversationId: snapshot.id,
			expectedRevision: snapshot.revision,
			action: {
				type: "put-data",
				scope: { type: "conversation" },
				namespace: "test",
				key: "landed",
				value: "yes",
			},
		});
		expect(edited.revision).toBe(1);

		const committed = module.commitSiblingVariant(
			siblingInput(snapshot.id, greeting.id),
		);
		expect(committed.revision).toBe(2);
		expect(committed.data).toContainEqual({
			namespace: "test",
			key: "landed",
			value: "yes",
		});
	});

	test("rejects a missing Conversation and a Message outside the Conversation with typed results", () => {
		const { module, snapshot } = setup(database);
		expect(() =>
			module.commitSiblingVariant(siblingInput(424242, 1)),
		).toThrow(ConversationNotFoundError);

		const other = module.create({
			name: "Other Chat",
			participants: [
				{ definition: adHoc("A") },
				{ definition: adHoc("B") },
			],
			control: { human: 0, model: 1 },
		});
		const outsider = other.messages[0];
		expect(outsider).toBeUndefined();
		expect(() =>
			module.commitSiblingVariant(siblingInput(snapshot.id, 424242)),
		).toThrow(InvalidConversationCommandError);
	});

	test("denies a sibling for a Message without captured historical context", () => {
		const module = createConversationModule(database);
		const imported = module.create({
			name: "Mixed Chat",
			participants: [
				{ definition: adHoc("Writer") },
				{ definition: adHoc("Maren Voss") },
			],
			control: { human: 0, model: 1 },
			messages: [
				{
					timestamp: "2026-08-20T10:00:00Z",
					variants: [
						{
							content: "Preserved",
							timestamp: "2026-08-20T10:00:00Z",
							selected: true,
						},
					],
				},
			],
		});

		const message = imported.messages[0];
		if (message === undefined) throw new Error("Message missing.");

		const denial = () =>
			module.commitSiblingVariant(siblingInput(imported.id, message.id));
		try {
			denial();
			throw new Error("Expected the sibling to be denied.");
		} catch (error) {
			if (error instanceof SiblingVariantUnavailableError) {
				expect(error.reason).toBe("missing-historical-context");
			} else if (error instanceof Error) {
				throw error;
			} else {
				throw new Error("Expected a typed SiblingVariantUnavailableError.");
			}
		}
		// Nothing committed: no Variant, no revision.
		expect(module.getSnapshot(imported.id)?.revision).toBe(0);
		expect(module.getSnapshot(imported.id)?.messages[0]?.variants).toHaveLength(1);
	});

	test("denies a sibling when a historical Participant no longer has a usable Definition", () => {
		const { module, snapshot, modelId } = setup(database);
		const greeting = snapshot.messages[0];
		if (greeting === undefined) throw new Error("Greeting missing.");

		const withJuno = module.execute({
			conversationId: snapshot.id,
			expectedRevision: snapshot.revision,
			action: { type: "add-participant", definition: adHoc("Juno Ashfeld") },
		});
		const junoId = withJuno.cast[2]?.id ?? 0;
		module.execute({
			conversationId: snapshot.id,
			expectedRevision: withJuno.revision,
			action: { type: "assign-control", seat: "model", participantId: junoId },
		});

		drizzle(database)
			.delete(participantPromptTable)
			.where(eq(participantPromptTable.participant_id, modelId))
			.run();

		const denial = () =>
			module.commitSiblingVariant(siblingInput(snapshot.id, greeting.id));
		try {
			denial();
			throw new Error("Expected the sibling to be denied.");
		} catch (error) {
			if (error instanceof SiblingVariantUnavailableError) {
				expect(error.reason).toBe("historical-participant-unavailable");
			} else if (error instanceof Error) {
				throw error;
			} else {
				throw new Error("Expected a typed SiblingVariantUnavailableError.");
			}
		}
	});
});