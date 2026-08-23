import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	conversationControlTable,
	messageTable,
	participantOpeningTable,
	participantPromptTable,
	participantTable,
} from "../database/schema";
import { openDatabase } from "../database/database";
import { createCharacterLibraryModule } from "../character-library";
import {
	createConversationModule,
	type ConversationSnapshot,
	InvalidConversationCommandError,
	StaleConversationRevisionError,
} from ".";
import type { ConversationModule } from ".";
import type { ConversationAction, ParticipantDefinition } from ".";

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

const castFor = (snapshot: ConversationSnapshot) => snapshot.cast;

const castNames = (snapshot: ConversationSnapshot) =>
	snapshot.cast.map((participant) => participant.name);

// Two ad-hoc Participants plus a third ad-hoc Participant appended later.
describe("Cast and Control management", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});
	afterEach(() => {
		database.close();
	});

	const setup = () => {
		const module = createConversationModule(database);
		const snapshot = module.create({
			name: "Cast Conversation",
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

	test("appends ad-hoc Participants at the stable Cast tail without writing history", () => {
		const { module, snapshot } = setup();
		const updated = append(module, snapshot, {
			type: "add-participant",
			definition: adHoc("Juno Ashfeld", ["The workshop bell rings."]),
		});

		expect(castNames(updated)).toEqual(["Writer", "Maren Voss", "Juno Ashfeld"]);
		expect(updated.cast.map((participant) => participant.position)).toEqual([
			1, 2, 3,
		]);
		// Appending never inserts Messages from openings.
		expect(updated.messages).toHaveLength(1);
		expect(updated.messages[0]?.variants[0]?.content).toBe("The lamp turns.");
		expect(updated.cast[2]?.sourceCharacterId).toBeNull();

		// Control is untouched: the new Participant is unseated and eligible.
		expect(updated.control).toEqual({
			humanParticipantId: snapshot.cast[0]?.id ?? 0,
			modelParticipantId: snapshot.cast[1]?.id ?? 0,
		});
		expect(updated.cast[2]?.removal).toEqual({
			eligible: true,
			reason: null,
			deletionMode: "hard-delete",
			affectedGenerationCount: 0,
		});
	});

	test("appends repeated Character forks as separate Participants with immutable provenance", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: {
				name: "Maren Voss",
				prompt: emptyPrompt(),
				openings: ["Opening one", "Opening two"],
			},
		});

		const { module, snapshot } = setup();
		const first = append(module, snapshot, {
			type: "add-participant",
			definition: {
				name: source.name,
				prompt: source.prompt,
				openings: [...source.openings],
			},
			sourceCharacterId: source.id,
		});
		const second = append(module, first, {
			type: "add-participant",
			definition: {
				name: source.name,
				prompt: source.prompt,
				openings: [...source.openings],
			},
			sourceCharacterId: source.id,
		});

		const forks = second.cast.filter(
			(participant) => participant.sourceCharacterId === source.id,
		);
		expect(forks).toHaveLength(2);
		expect(forks[0]?.id).not.toBe(forks[1]?.id);
		// Duplicate labels derive from Cast order for the same name.
		expect(second.cast.map((participant) => participant.duplicateLabel)).toEqual([
			"Writer",
			"Maren Voss",
			"Maren Voss (2)",
			"Maren Voss (3)",
		]);
		// Forks keep their own copied Definitions.
		expect(forks[1]?.openings).toEqual(["Opening one", "Opening two"]);
	});

	test("edits a Participant's name, Prompt, and openings through separate Apply actions", () => {
		const { module, snapshot, modelId } = setup();
		const renamed = append(module, snapshot, {
			type: "rename-participant",
			participantId: modelId,
			name: "  Maren Voss, Archivist  ",
		});
		expect(renamed.cast[1]?.name).toBe("Maren Voss, Archivist");

		const promptApplied = append(module, renamed, {
			type: "replace-participant-prompt",
			participantId: modelId,
			prompt: {
				systemInstruction: "Keep responses literary.",
				identity: "Lighthouse archivist.",
				scenario: "A storm season.",
				exampleDialogue: "<START>\n{{user}}: Who tends the light?",
				postHistoryInstruction: "Favor tactile detail.",
			},
		});
		expect(promptApplied.cast[1]?.prompt).toEqual({
			systemInstruction: "Keep responses literary.",
			identity: "Lighthouse archivist.",
			scenario: "A storm season.",
			exampleDialogue: "<START>\n{{user}}: Who tends the light?",
			postHistoryInstruction: "Favor tactile detail.",
		});

		const openingsApplied = append(module, promptApplied, {
			type: "replace-participant-openings",
			participantId: modelId,
			openings: ["Rain writes on every window.", "Rain writes on every window."],
		});
		expect(openingsApplied.cast[1]?.openings).toEqual([
			"Rain writes on every window.",
			"Rain writes on every window.",
		]);
		// Empty replacement is valid and clears the list.
		const cleared = append(module, openingsApplied, {
			type: "replace-participant-openings",
			participantId: modelId,
			openings: [],
		});
		expect(cleared.cast[1]?.openings).toEqual([]);

		// Editing the local Definition never rewrites existing history: the
		// greeting keeps its captured Author Stamp and opening text.
		const greeting = cleared.messages[0];
		expect(greeting?.author).toEqual({
			participantId: modelId,
			capturedName: "Maren Voss",
			inCast: true,
		});
		expect(greeting?.variants[0]?.content).toBe("The lamp turns.");
		expect(cleared.revision).toBe(snapshot.revision + 4);
	});

	test("rejects blank names and blank openings with typed validation", () => {
		const { module, snapshot, modelId } = setup();
		expect(() =>
			append(module, snapshot, {
				type: "rename-participant",
				participantId: modelId,
				name: "   ",
			}),
		).toThrow(InvalidConversationCommandError);
		expect(() =>
			append(module, snapshot, {
				type: "add-participant",
				definition: adHoc("Blank Openings", ["   "]),
			}),
		).toThrow(InvalidConversationCommandError);
		expect(() =>
			append(module, snapshot, {
				type: "replace-participant-openings",
				participantId: modelId,
				openings: ["\t"],
			}),
		).toThrow(InvalidConversationCommandError);
		expect(createConversationModule(database).getSnapshot(snapshot.id)).toEqual(
			snapshot,
		);
	});

	test("rejects edits referencing a Participant outside the Conversation", () => {
		const { module, snapshot } = setup();
		const other = createConversationModule(database).create({
			name: "Other",
			participants: [
				{ definition: adHoc("Outsider") },
				{ definition: adHoc("Local") },
			],
			control: { human: 0, model: 1 },
		});
		const outsiderId = other.cast[0]?.id ?? 0;

		expect(() =>
			append(module, snapshot, {
				type: "rename-participant",
				participantId: outsiderId,
				name: "Renamed",
			}),
		).toThrow(InvalidConversationCommandError);
		expect(() =>
			append(module, snapshot, {
				type: "replace-participant-prompt",
				participantId: outsiderId,
				prompt: emptyPrompt(),
			}),
		).toThrow(InvalidConversationCommandError);
		expect(() =>
			append(module, snapshot, {
				type: "assign-control",
				seat: "human",
				participantId: outsiderId,
			}),
		).toThrow(InvalidConversationCommandError);
	});

	test("rejects stale Cast commands with the typed conflict and commits nothing", () => {
		const { module, snapshot } = setup();
		append(module, snapshot, {
			type: "add-participant",
			definition: adHoc("Juno Ashfeld"),
		});

		expect(() =>
			append(module, snapshot, {
				type: "add-participant",
				definition: adHoc("Stale Addition"),
			}),
		).toThrow(StaleConversationRevisionError);
		expect(castNames(createConversationModule(database).getSnapshot(snapshot.id) ?? snapshot)).toEqual([
			"Writer",
			"Maren Voss",
			"Juno Ashfeld",
		]);
	});

	test("a two-person Cast swaps atomically and can never become locked", () => {
		const { module, snapshot, humanId, modelId } = setup();
		const swapped = append(module, snapshot, {
			type: "assign-control",
			seat: "model",
			participantId: humanId,
		});
		expect(swapped.control).toEqual({
			humanParticipantId: modelId,
			modelParticipantId: humanId,
		});

		// Swapping back works from the swapped state.
		const swappedBack = append(module, swapped, {
			type: "assign-control",
			seat: "human",
			participantId: humanId,
		});
		expect(swappedBack.control).toEqual({
			humanParticipantId: humanId,
			modelParticipantId: modelId,
		});
		// Both seats stay occupied and the Cast stays complete.
		expect(swappedBack.playable).toBe(true);
		expect(swappedBack.controlValidity).toEqual({ valid: true, reason: null });
	});

	test("reassigning to an unseated Participant replaces only the chosen seat", () => {
		const { module, snapshot, humanId } = setup();
		const withThird = append(module, snapshot, {
			type: "add-participant",
			definition: adHoc("Juno Ashfeld"),
		});
		const thirdId = withThird.cast[2]?.id ?? 0;

		const replaced = append(module, withThird, {
			type: "assign-control",
			seat: "human",
			participantId: thirdId,
		});
		expect(replaced.control.humanParticipantId).toBe(thirdId);
		// The model seat is untouched; only the human seat changed.
		expect(replaced.control.modelParticipantId).toBe(
			withThird.control.modelParticipantId,
		);
		// The displaced Participant stays active but becomes removable.
		const displaced = replaced.cast.find(
			(participant) => participant.id === humanId,
		);
		expect(displaced?.removal).toEqual({
			eligible: true,
			reason: null,
			// The greeting's captured historical pair still references the
			// displaced Participant, so removal tombstones it and that
			// greeting loses its ability to generate a new sibling Variant.
			deletionMode: "tombstone",
			affectedGenerationCount: 1,
		});
		expect(displaced?.position).toBe(1);
		expect(replaced.playable).toBe(true);
	});

	test("seated Participants are ineligible for removal in every state", () => {
		const { module, snapshot } = setup();
		const withThird = append(module, snapshot, {
			type: "add-participant",
			definition: adHoc("Juno Ashfeld"),
		});

		for (const participant of withThird.cast) {
			const seated =
				participant.id === withThird.control.humanParticipantId ||
				participant.id === withThird.control.modelParticipantId;
			expect(participant.removal.eligible).toBe(!seated);
			expect(participant.removal.reason).toBe(
				seated ? "control-assigned" : null,
			);
		}
		expect(castFor(withThird)).toHaveLength(3);
	});

	test("a larger Cast swap exchanges the two seats without touching unseated members", () => {
		const { module, snapshot } = setup();
		const withThird = append(module, snapshot, {
			type: "add-participant",
			definition: adHoc("Juno Ashfeld"),
		});
		const withFourth = append(module, withThird, {
			type: "add-participant",
			definition: adHoc("Bram Okafor"),
		});
		const humanId = withFourth.control.humanParticipantId ?? 0;
		const modelId = withFourth.control.modelParticipantId ?? 0;

		const swapped = append(module, withFourth, {
			type: "assign-control",
			seat: "human",
			participantId: modelId,
		});
		expect(swapped.control.humanParticipantId).toBe(modelId);
		expect(swapped.control.modelParticipantId).toBe(humanId);
		// Remaining Cast members are unseated and untouched.
		expect(castNames(swapped)).toEqual([
			"Writer",
			"Maren Voss",
			"Juno Ashfeld",
			"Bram Okafor",
		]);
		expect(swapped.cast[2]?.removal).toEqual({
			eligible: true,
			reason: null,
			deletionMode: "hard-delete",
			affectedGenerationCount: 0,
		});
	});

	test("derives duplicate labels, Control validity, and removal eligibility for clients", () => {
		const { module, snapshot } = setup();
		const updated = append(module, snapshot, {
			type: "add-participant",
			definition: adHoc("Writer"),
		});
		expect(updated.cast.map((participant) => participant.duplicateLabel)).toEqual([
			"Writer",
			"Maren Voss",
			"Writer (2)",
		]);
		expect(updated.controlValidity).toEqual({ valid: true, reason: null });
		expect(updated.playable).toBe(true);

		// An incomplete Conversation derives the missing-seat reason.
		const incomplete = createConversationModule(database).create({
			name: "Incomplete",
			participants: [{ definition: adHoc("Solo") }],
		});
		expect(incomplete.playable).toBe(false);
		expect(incomplete.controlValidity).toEqual({
			valid: false,
			reason: "missing-seat",
		});
		expect(incomplete.capabilities.compose.available).toBe(false);
		expect(incomplete.capabilities.compose.reason).toBe(
			"conversation-not-playable",
		);
	});

	test("an incomplete Conversation can fill the missing seat without clearing the existing one", () => {
		// Build a one-seat assignment through the create seam by assigning
		// both seats and then reassigning is not possible (seats cannot be
		// cleared), so construct the incomplete state from a no-control
		// preserve record instead, then assign one seat.
		const module = createConversationModule(database);
		const preserved = module.create({
			name: "Preserved Import",
			participants: [
				{ definition: adHoc("Writer") },
				{ definition: adHoc("Maren Voss") },
			],
		});
		const humanOnly = module.execute({
			conversationId: preserved.id,
			expectedRevision: preserved.revision,
			action: {
				type: "assign-control",
				seat: "human",
				participantId: preserved.cast[0]?.id ?? 0,
			},
		});
		expect(humanOnly.control).toEqual({
			humanParticipantId: preserved.cast[0]?.id ?? 0,
			modelParticipantId: null,
		});
		expect(humanOnly.controlValidity).toEqual({
			valid: false,
			reason: "missing-seat",
		});

		const completed = module.execute({
			conversationId: preserved.id,
			expectedRevision: humanOnly.revision,
			action: {
				type: "assign-control",
				seat: "model",
				participantId: preserved.cast[1]?.id ?? 0,
			},
		});
		expect(completed.control).toEqual({
			humanParticipantId: preserved.cast[0]?.id ?? 0,
			modelParticipantId: preserved.cast[1]?.id ?? 0,
		});
		expect(completed.playable).toBe(true);
		expect(completed.controlValidity).toEqual({ valid: true, reason: null });
	});

	test("rejects already-assigned seat selections without changing the revision", () => {
		const { module, snapshot, humanId } = setup();
		expect(() =>
			append(module, snapshot, {
				type: "assign-control",
				seat: "human",
				participantId: humanId,
			}),
		).toThrow(InvalidConversationCommandError);
		expect(createConversationModule(database).getSnapshot(snapshot.id)?.revision).toBe(
			snapshot.revision,
		);
	});

	test("Participant edits never modify the source Character", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: {
				name: "Maren Voss",
				prompt: {
					systemInstruction: "",
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
			name: "Forked",
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

		const edited = append(module, snapshot, {
			type: "rename-participant",
			participantId: modelId,
			name: "Local Maren",
		});
		const withPrompt = append(module, edited, {
			type: "replace-participant-prompt",
			participantId: modelId,
			prompt: {
				systemInstruction: "",
				identity: "A local variant.",
				scenario: "",
				exampleDialogue: "",
				postHistoryInstruction: "",
			},
		});

		const reread = library.get(source.id);
		expect(reread?.name).toBe("Maren Voss");
		expect(reread?.prompt.identity).toBe("Lighthouse archivist.");
		expect(reread?.openings).toEqual(["The lamp turns."]);
		// The Participant keeps its independent copy and provenance.
		expect(withPrompt.cast[1]?.name).toBe("Local Maren");
		expect(withPrompt.cast[1]?.sourceCharacterId).toBe(source.id);
	});

	test("normalizes names while preserving case and Unicode", () => {
		const { module, snapshot, modelId } = setup();
		const renamed = append(module, snapshot, {
			type: "rename-participant",
			participantId: modelId,
			name: "  Åse Voss  ",
		});
		expect(renamed.cast[1]?.name).toBe("Åse Voss");
	});

	test("an incomplete Conversation keeps configuration commands available", () => {
		const module = createConversationModule(database);
		const preserved = module.create({
			name: "Preserved",
			messages: [
				{
					timestamp: "2026-08-20T10:00:00Z",
					variants: [
						{ content: "Preserved", timestamp: "2026-08-20T10:00:00Z", selected: true },
					],
				},
			],
		});
		const updated = module.execute({
			conversationId: preserved.id,
			expectedRevision: preserved.revision,
			action: { type: "add-participant", definition: adHoc("Writer") },
		});
		expect(updated.cast.map((participant) => participant.name)).toEqual([
			"Writer",
		]);
		expect(updated.playable).toBe(false);
		// New Participant appears with its Prompt row persisted.
		const promptCount = drizzle(database)
			.select()
			.from(participantPromptTable)
			.all().length;
		expect(promptCount).toBe(1);
		expect(
			drizzle(database)
				.select()
				.from(participantOpeningTable)
				.all().length,
		).toBe(0);
		expect(
			drizzle(database).select().from(messageTable).all().length,
		).toBe(1);
		expect(
			drizzle(database)
				.select()
				.from(conversationControlTable)
				.all().length,
		).toBe(0);
		expect(
			drizzle(database).select().from(participantTable).all().length,
		).toBe(1);
	});
});