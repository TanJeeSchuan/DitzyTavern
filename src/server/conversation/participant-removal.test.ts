import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	participantOpeningTable,
	participantPromptTable,
	participantTable,
} from "../database/schema";
import { openDatabase } from "../database/database";
import { createCharacterLibraryModule } from "../character-library";
import {
	createConversationModule,
	InvalidConversationCommandError,
	ParticipantNotRemovableError,
	SiblingVariantUnavailableError,
	StaleConversationRevisionError,
	type ConversationAction,
	type ConversationModule,
	type ConversationSnapshot,
	type ParticipantDefinition,
} from ".";
import { generateSiblingVariant } from "../workflows/generate";

const emptyPrompt = () => ({
	systemInstruction: "",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
});

const adHoc = (
	name: string,
	openings: readonly string[] = [],
): ParticipantDefinition => ({ name, prompt: emptyPrompt(), openings });

const castNames = (snapshot: ConversationSnapshot) =>
	snapshot.cast.map((participant) => participant.name);

// Participant removal through the public Conversation seam on a real
// migrated SQLite store: seat protection, hard deletion versus tombstoning,
// position compaction, regeneration loss, historical display state, Swipe
// denial, nonrestorable re-addition, and final-reference garbage collection.
describe("Participant removal", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});
	afterEach(() => {
		database.close();
	});

	const append = (
		module: ConversationModule,
		snapshot: ConversationSnapshot,
		action: ConversationAction,
	) =>
		module.execute({
			conversationId: snapshot.id,
			expectedRevision: snapshot.revision,
			action,
		});

	const setup = () => {
		const module = createConversationModule(database);
		const snapshot = module.create({
			name: "Removal Conversation",
			participants: [
				{ definition: adHoc("Writer") },
				{ definition: adHoc("Maren Voss", ["The lamp turns."]) },
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

	// Appends a third Participant and replaces the model seat with it, so the
	// original model Participant becomes unseated (and removable) while the
	// Conversation stays playable.
	const unseatModel = (
		module: ConversationModule,
		snapshot: ConversationSnapshot,
	) => {
		const withThird = append(module, snapshot, {
			type: "add-participant",
			definition: adHoc("Juno Ashfeld"),
		});
		const thirdId = withThird.cast[2]?.id ?? 0;
		return append(module, withThird, {
			type: "assign-control",
			seat: "model",
			participantId: thirdId,
		});
	};

	const unseatHuman = (
		module: ConversationModule,
		snapshot: ConversationSnapshot,
	) => {
		const withThird = append(module, snapshot, {
			type: "add-participant",
			definition: adHoc("Juno Ashfeld"),
		});
		const thirdId = withThird.cast[2]?.id ?? 0;
		return append(module, withThird, {
			type: "assign-control",
			seat: "human",
			participantId: thirdId,
		});
	};

	test("seated Participants are protected and the derived capability names the reason", () => {
		const { module, snapshot, humanId, modelId } = setup();

		for (const participant of snapshot.cast) {
			expect(participant.removal).toEqual({
				eligible: false,
				reason: "control-assigned",
				deletionMode: null,
				affectedGenerationCount: 0,
			});
		}

		expect(() =>
			append(module, snapshot, {
				type: "remove-participant",
				participantId: humanId,
			}),
		).toThrow(ParticipantNotRemovableError);
		expect(() =>
			append(module, snapshot, {
				type: "remove-participant",
				participantId: modelId,
			}),
		).toThrow(ParticipantNotRemovableError);

		// The rejected command committed nothing: Cast, seats, and revision
		// are unchanged.
		const reread = createConversationModule(database).getSnapshot(snapshot.id);
		expect(reread?.cast).toEqual(snapshot.cast);
		expect(reread?.revision).toBe(snapshot.revision);
	});

	test("a stale or missing removal target fails with the typed outcomes", () => {
		const { module, snapshot, humanId } = setup();
		expect(() =>
			module.execute({
				conversationId: snapshot.id,
				expectedRevision: snapshot.revision + 99,
				action: { type: "remove-participant", participantId: humanId },
			}),
		).toThrow(StaleConversationRevisionError);

		const other = createConversationModule(database).create({
			name: "Other",
			participants: [
				{ definition: adHoc("Outsider") },
				{ definition: adHoc("Local") },
			],
			control: { human: 0, model: 1 },
		});
		expect(() =>
			append(module, snapshot, {
				type: "remove-participant",
				participantId: other.cast[0]?.id ?? 0,
			}),
		).toThrow(InvalidConversationCommandError);
	});

	test("removal eligibility derives the deletion mode and the regeneration loss count", () => {
		const { module, snapshot, modelId } = setup();
		const unseated = unseatModel(module, snapshot);

		const maren = unseated.cast.find(
			(participant) => participant.id === modelId,
		);
		expect(maren).toBeDefined();
		expect(maren?.removal).toEqual({
			eligible: true,
			reason: null,
			// The greeting still refers to Maren (author and model of the
			// historical pair), so removal tombstones her…
			deletionMode: "tombstone",
			// …and that greeting currently could generate a new sibling
			// Variant, so it counts as losing that ability.
			affectedGenerationCount: 1,
		});

		// Unseated Participants with no references derive a hard delete.
		const added = append(module, unseated, {
			type: "add-participant",
			definition: adHoc("Bram Okafor"),
		});
		expect(added.cast.at(-1)?.removal).toEqual({
			eligible: true,
			reason: null,
			deletionMode: "hard-delete",
			affectedGenerationCount: 0,
		});
		// Seated Participants never carry an impact.
		expect(added.cast[0]?.removal).toEqual({
			eligible: false,
			reason: "control-assigned",
			deletionMode: null,
			affectedGenerationCount: 0,
		});
	});

	test("an unreferenced unseated Participant is hard-deleted with later Cast positions compacted", () => {
		const { module, snapshot } = setup();
		const withThird = append(module, snapshot, {
			type: "add-participant",
			definition: adHoc("Juno Ashfeld"),
		});
		const withFourth = append(module, withThird, {
			type: "add-participant",
			definition: adHoc("Bram Okafor"),
		});
		const junoId = withFourth.cast[2]?.id ?? 0;

		const removed = append(module, withFourth, {
			type: "remove-participant",
			participantId: junoId,
		});
		expect(castNames(removed)).toEqual(["Writer", "Maren Voss", "Bram Okafor"]);
		expect(removed.cast.map((participant) => participant.position)).toEqual([
			1, 2, 3,
		]);
		expect(removed.control).toEqual(withFourth.control);
		expect(removed.playable).toBe(true);
		expect(removed.messages).toHaveLength(1);

		// Hard deletion removed every row: lifecycle base plus children.
		const drizzleDb = drizzle(database);
		expect(
			drizzleDb
				.select()
				.from(participantTable)
				.where(eq(participantTable.id, junoId))
				.get(),
		).toBeUndefined();
		expect(
			drizzleDb
				.select()
				.from(participantPromptTable)
				.where(eq(participantPromptTable.participant_id, junoId))
				.get(),
		).toBeUndefined();
		expect(
			drizzleDb
				.select()
				.from(participantOpeningTable)
				.where(eq(participantOpeningTable.participant_id, junoId))
				.get(),
		).toBeUndefined();
	});

	test("a referenced Participant becomes a nonrestorable tombstone stripping Definition children while retaining identity, final name, provenance, and Conversation", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: {
				name: "Maren Voss",
				prompt: {
					systemInstruction: "Keep responses literary.",
					identity: "Lighthouse archivist.",
					scenario: "",
					exampleDialogue: "",
					postHistoryInstruction: "",
				},
				openings: ["The lamp turns."],
			},
		});

		const module = createConversationModule(database);
		const snapshot = module.create({
			name: "Forked Removal",
			participants: [
				{ definition: adHoc("Writer") },
				{
					definition: {
						name: source.name,
						prompt: source.prompt,
						openings: [...source.openings],
					},
					sourceCharacterId: source.id,
				},
			],
			control: { human: 0, model: 1 },
		});
		const modelId = snapshot.cast[1]?.id ?? 0;
		const unseated = unseatModel(module, snapshot);

		const removed = append(module, unseated, {
			type: "remove-participant",
			participantId: modelId,
		});
		// The tombstone leaves the Cast while general members and seats stay.
		expect(castNames(removed)).toEqual(["Writer", "Juno Ashfeld"]);
		expect(removed.cast.map((participant) => participant.position)).toEqual([
			1, 2,
		]);
		expect(removed.control).toEqual(unseated.control);

		const drizzleDb = drizzle(database);
		const tombstone = drizzleDb
			.select()
			.from(participantTable)
			.where(eq(participantTable.id, modelId))
			.get();
		expect(tombstone).toBeDefined();
		expect(tombstone?.deleted_at).not.toBeNull();
		// Retained: stable identity, final name, Conversation identity, and
		// immutable Character provenance. Stripped: Definition children and
		// any Cast position.
		expect(tombstone?.chat_id).toBe(snapshot.id);
		expect(tombstone?.name).toBe("Maren Voss");
		expect(tombstone?.source_character_id).toBe(source.id);
		expect(tombstone?.position).toBe(0);
		expect(
			drizzleDb
				.select()
				.from(participantPromptTable)
				.where(eq(participantPromptTable.participant_id, modelId))
				.get(),
		).toBeUndefined();
		expect(
			drizzleDb
				.select()
				.from(participantOpeningTable)
				.where(eq(participantOpeningTable.participant_id, modelId))
				.get(),
		).toBeUndefined();

		// The tombstone is nonrestorable: every command treats it as missing
		// rather than as a usable Participant.
		expect(() =>
			append(module, removed, {
				type: "remove-participant",
				participantId: modelId,
			}),
		).toThrow(InvalidConversationCommandError);
		expect(() =>
			append(module, removed, {
				type: "rename-participant",
				participantId: modelId,
				name: "Renamed",
			}),
		).toThrow(InvalidConversationCommandError);
	});

	test("an author-only reference keeps the tombstone alive", () => {
		// No openings, so no greeting is created: the only reference to
		// Writer will be the composed Message's Author Stamp.
		const module = createConversationModule(database);
		const snapshot = module.create({
			name: "Composed History",
			participants: [
				{ definition: adHoc("Writer") },
				{ definition: adHoc("Maren Voss") },
			],
			control: { human: 0, model: 1 },
		});
		const writerId = snapshot.cast[0]?.id ?? 0;
		const composed = append(module, snapshot, {
			type: "create-message",
			timestamp: "2026-08-20T10:00:00Z",
			variantContents: ["Composed by Writer"],
			authorParticipantId: writerId,
		});
		expect(composed.messages[0]?.author).toEqual({
			participantId: writerId,
			capturedName: "Writer",
			inCast: true,
		});
		// Compose Messages carry no historical pair, so none of them can
		// regenerate: the removal impact counts zero even though the Author
		// Stamp demands a tombstone.
		const unseated = unseatHuman(module, composed);
		const writer = unseated.cast.find(
			(participant) => participant.id === writerId,
		);
		expect(writer?.removal).toEqual({
			eligible: true,
			reason: null,
			deletionMode: "tombstone",
			affectedGenerationCount: 0,
		});

		const removed = append(module, unseated, {
			type: "remove-participant",
			participantId: writerId,
		});
		expect(removed.cast.find((p) => p.id === writerId)).toBeUndefined();
		const tombstone = drizzle(database)
			.select()
			.from(participantTable)
			.where(eq(participantTable.id, writerId))
			.get();
		expect(tombstone?.deleted_at).not.toBeNull();
		// The composed Message still displays the captured name with the
		// removed state.
		expect(removed.messages[0]?.author).toEqual({
			participantId: writerId,
			capturedName: "Writer",
			inCast: false,
		});
	});

	test("a historical-Control reference kind keeps the tombstone alive and counts the regeneration loss", () => {
		const { module, snapshot, humanId } = setup();
		// The greeting's historical pair is (Writer, Maren); Writer is
		// referenced only as the context human, never as an author.
		const unseated = unseatHuman(module, snapshot);
		const writer = unseated.cast.find(
			(participant) => participant.id === humanId,
		);
		expect(writer?.removal).toEqual({
			eligible: true,
			reason: null,
			deletionMode: "tombstone",
			affectedGenerationCount: 1,
		});

		const removed = append(module, unseated, {
			type: "remove-participant",
			participantId: humanId,
		});
		const tombstone = drizzle(database)
			.select()
			.from(participantTable)
			.where(eq(participantTable.id, humanId))
			.get();
		expect(tombstone?.deleted_at).not.toBeNull();
		// The greeting authored by Maren keeps its pair pointing at the
		// tombstone, displaying no-longer-in-Cast for both participants.
		expect(removed.messages[0]?.author).toEqual({
			participantId: snapshot.cast[1]?.id,
			capturedName: "Maren Voss",
			inCast: true,
		});
		expect(removed.messages[0]?.historicalContext).toEqual({
			humanParticipantId: humanId,
			modelParticipantId: snapshot.cast[1]?.id,
		});
	});

	test("historical Messages display the captured name with no-longer-in-Cast state after removal", () => {
		const { module, snapshot, modelId } = setup();
		const unseated = unseatModel(module, snapshot);
		const removed = append(module, unseated, {
			type: "remove-participant",
			participantId: modelId,
		});

		const greeting = removed.messages[0];
		expect(greeting?.author).toEqual({
			participantId: modelId,
			capturedName: "Maren Voss",
			inCast: false,
		});
		expect(greeting?.variants.map((variant) => variant.content)).toEqual([
			"The lamp turns.",
		]);
	});

	test("generation that requires a removed Participant is denied while existing sibling Variants stay selectable and editable", async () => {
		const { module, snapshot, modelId } = setup();
		const unseated = unseatModel(module, snapshot);
		const removed = append(module, unseated, {
			type: "remove-participant",
			participantId: modelId,
		});

		// The derived Swipe capability states the typed reason.
		expect(removed.messages[0]?.swipe).toEqual({
			eligible: false,
			reason: "historical-participant-unavailable",
		});

		// The workflow denies a new sibling Variant with the same typed
		// reason before any transport is contacted.
		const greetingId = removed.messages[0]?.id ?? 0;
		await expect(
			generateSiblingVariant(database, {
				conversationId: removed.id,
				messageId: greetingId,
				generate: async () => "Never produced",
			}),
		).rejects.toThrow(SiblingVariantUnavailableError);

		// Existing Variants remain fully usable.
		const variant = removed.messages[0]?.variants[0];
		const selected = append(module, removed, {
			type: "select-variant",
			messageId: greetingId,
			variantId: variant?.id ?? 0,
		});
		expect(selected.messages[0]?.variants[0]?.selected).toBe(true);
		const edited = append(module, selected, {
			type: "edit-variant",
			messageId: greetingId,
			variantId: variant?.id ?? 0,
			content: "Edited Lamp",
		});
		expect(edited.messages[0]?.variants[0]?.content).toBe("Edited Lamp");
		expect(edited.messages[0]?.author).toEqual(removed.messages[0]?.author);
	});

	test("re-adding the same name or source Character creates a new Participant identity and never restores the tombstone", () => {
		const { module, snapshot, modelId } = setup();
		const unseated = unseatModel(module, snapshot);
		const removed = append(module, unseated, {
			type: "remove-participant",
			participantId: modelId,
		});

		// Re-adding the same name through the raw command.
		const reAdded = append(module, removed, {
			type: "add-participant",
			definition: adHoc("Maren Voss", ["A fresh start."]),
		});
		const freshParticipant = reAdded.cast.at(-1);
		expect(freshParticipant?.id).not.toBe(modelId);
		expect(freshParticipant?.name).toBe("Maren Voss");
		expect(freshParticipant?.sourceCharacterId).toBeNull();

		// History still points at the old identity, which remains removed.
		expect(reAdded.messages[0]?.author?.participantId).toBe(modelId);
		expect(reAdded.messages[0]?.author?.inCast).toBe(false);

		// Re-forking the same source Character also creates a fresh identity
		// and never silently reuses the tombstone.
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: {
				name: "Maren Voss",
				prompt: emptyPrompt(),
				openings: ["Forked opening."],
			},
		});
		const forked = createCharacterLibraryModule(database);
		const character = forked.get(source.id);
		const withFork = append(module, reAdded, {
			type: "add-participant",
			definition: {
				name: character?.name ?? "Maren Voss",
				prompt: character?.prompt ?? emptyPrompt(),
				openings: character?.openings ?? [],
			},
			sourceCharacterId: source.id,
		});
		const forkedParticipant = withFork.cast.at(-1);
		expect(forkedParticipant?.id).not.toBe(modelId);
		expect(forkedParticipant?.id).not.toBe(freshParticipant?.id);
		expect(forkedParticipant?.sourceCharacterId).toBe(source.id);

		// The tombstone row still exists with its stripped state; it was
		// neither deleted nor restored.
		const tombstone = drizzle(database)
			.select()
			.from(participantTable)
			.where(eq(participantTable.id, modelId))
			.get();
		expect(tombstone?.deleted_at).not.toBeNull();
		expect(tombstone?.name).toBe("Maren Voss");
	});

	test("tombstones are garbage-collected in the same domain transaction after the final retained reference disappears", () => {
		const { module, snapshot, humanId } = setup();
		// Give Writer two references: the greeting's historical pair and a
		// composed Message's Author Stamp.
		const composed = append(module, snapshot, {
			type: "create-message",
			timestamp: "2026-08-20T11:00:00Z",
			variantContents: ["Writer writes directly."],
			authorParticipantId: humanId,
		});
		const unseated = unseatHuman(module, composed);
		const removed = append(module, unseated, {
			type: "remove-participant",
			participantId: humanId,
		});
		const tombstoneId = humanId;

		// Deleting one of the two referencing Messages keeps the tombstone.
		const greetingId = removed.messages[0]?.id ?? 0;
		const oneRefLeft = append(module, removed, {
			type: "delete-message",
			messageId: greetingId,
		});
		expect(
			drizzle(database).select().from(participantTable).all().length,
		).toBe(3);
		expect(oneRefLeft.messages.map((message) => message.position)).toEqual([2]);

		// Deleting the final referencing Message garbage-collects the
		// tombstone inside the same command transaction.
		const finalRef = oneRefLeft.messages[0]?.id ?? 0;
		const collected = append(module, oneRefLeft, {
			type: "delete-message",
			messageId: finalRef,
		});
		expect(collected.messages).toEqual([]);
		expect(
			drizzle(database)
				.select()
				.from(participantTable)
				.where(eq(participantTable.id, tombstoneId))
				.get(),
		).toBeUndefined();
		// The Cast is untouched by tombstone collection and stays compacted.
		expect(castNames(collected)).toEqual(["Maren Voss", "Juno Ashfeld"]);
		expect(collected.cast.map((p) => p.position)).toEqual([1, 2]);
	});
});
