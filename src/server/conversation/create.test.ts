import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	characterOpeningTable,
	characterPromptTable,
	characterTable,
	conversationTable,
	conversationControlTable,
	messageTable,
	messageVariantTable,
	participantOpeningTable,
	participantPromptTable,
	participantTable,
} from "../database/schema";
import { openDatabase } from "../database/database";
import { createCharacterLibraryModule } from "../character-library";
import { createConversationModule, InvalidConversationCreationError } from ".";
import type { ConversationCreationInput, ParticipantDefinition } from ".";

const prompt = (overrides: Partial<ParticipantDefinition["prompt"]> = {}) => ({
	systemInstruction: "Keep the scene grounded.",
	identity: "",
	scenario: "",
	exampleDialogue: "",
	postHistoryInstruction: "",
	...overrides,
});

const adHoc = (
	name: string,
	openings: string[] = [],
	promptOverrides: Partial<ParticipantDefinition["prompt"]> = {},
): ParticipantDefinition => ({
	name,
	prompt: prompt(promptOverrides),
	openings,
});

const inputWith = (
	overrides: Partial<ConversationCreationInput> = {},
): ConversationCreationInput => ({
	name: "Native Conversation",
	participants: [
		{ definition: adHoc("Writer") },
		{ definition: adHoc("Maren Voss", ["First greeting", "Second greeting"]) },
	],
	control: { human: 0, model: 1 },
	...overrides,
});

describe("Conversation creation", () => {
	let database: Database;

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
	});
	afterEach(() => {
		database.close();
	});

	const countRows = (
		table:
			| typeof conversationTable
			| typeof messageTable
			| typeof messageVariantTable
			| typeof participantTable
			| typeof participantPromptTable
			| typeof participantOpeningTable
			| typeof conversationControlTable
			| typeof characterTable
			| typeof characterPromptTable
			| typeof characterOpeningTable,
	) => drizzle(database).select().from(table).all().length;

	test("creates a playable Conversation from two distinct ad-hoc Participants", () => {
		const conversation = createConversationModule(database);
		const snapshot = conversation.create(
			inputWith({
				participants: [
					{
						definition: adHoc("Writer", ["Human opening"], {
							identity: "The Writer guides the story.",
						}),
					},
					{ definition: adHoc("Maren Voss", [], prompt({ scenario: "A storm." })) },
				],
				createdAt: "2026-08-21T09:00:00.000Z",
			}),
		);

		expect(snapshot.revision).toBe(0);
		expect(snapshot.playable).toBe(true);
		expect(snapshot.capabilities.compose).toEqual({
			available: true,
			reason: null,
		});
		expect(snapshot.cast.map((participant) => participant.position)).toEqual([1, 2]);
		expect(snapshot.cast[0]?.name).toBe("Writer");
		expect(snapshot.cast[0]?.prompt.identity).toBe("The Writer guides the story.");
		expect(snapshot.cast[1]?.prompt.scenario).toBe("A storm.");
		expect(snapshot.cast.every((participant) => participant.sourceCharacterId === null)).toBe(true);

		expect(snapshot.control).toEqual({
			humanParticipantId: snapshot.cast[0]?.id,
			modelParticipantId: snapshot.cast[1]?.id,
		});

		// Human openings never become history; only the model seat's do.
		expect(snapshot.messages).toEqual([]);

		expect(conversation.getSnapshot(snapshot.id)).toEqual(snapshot);
	});

	test("converts the initial model Participant's openings into one Message of ordered sibling Variants with the first selected", () => {
		const conversation = createConversationModule(database);
		const snapshot = conversation.create(
			inputWith({
				participants: [
					{ definition: adHoc("Writer", ["Should never appear"]) },
					{ definition: adHoc("Maren Voss", ["Greeting B", "Greeting A", "Greeting A"]) },
				],
				control: { human: 0, model: 1 },
			}),
		);

		expect(snapshot.messages).toHaveLength(1);
		const greeting = snapshot.messages[0];
		expect(greeting?.variants.map((variant) => variant.content)).toEqual([
			"Greeting B",
			"Greeting A",
			"Greeting A",
		]);
		expect(greeting?.variants.map((variant) => variant.selected)).toEqual([
			true,
			false,
			false,
		]);
		expect(greeting?.author).toEqual({
			participantId: snapshot.cast[1]?.id ?? null,
			capturedName: "Maren Voss",
			inCast: true,
		});
		expect(greeting?.historicalContext).toEqual({
			humanParticipantId: snapshot.cast[0]?.id,
			modelParticipantId: snapshot.cast[1]?.id,
		});
	});

	test("compiles greeting openings with owner-relative macros while storing them raw", () => {
		const conversation = createConversationModule(database);
		const snapshot = conversation.create(
			inputWith({
				participants: [
					{ definition: adHoc("Writer") },
					{
						definition: adHoc("Maren Voss", [
							"{{self}} greets {{other}}.",
							"Say \\{{self}} plainly.",
							"{{SELF}} and {{user}} stay literal.",
						]),
					},
				],
				control: { human: 0, model: 1 },
			}),
		);

		const greeting = snapshot.messages[0];
		expect(greeting?.variants.map((variant) => variant.content)).toEqual([
			"Maren Voss greets Writer.",
			"Say {{self}} plainly.",
			"{{SELF}} and {{user}} stay literal.",
		]);
		expect(greeting?.author).toEqual({
			participantId: snapshot.cast[1]?.id ?? null,
			capturedName: "Maren Voss",
			inCast: true,
		});

		// The stored openings remain raw and unexpanded.
		expect(snapshot.cast[1]?.openings).toEqual([
			"{{self}} greets {{other}}.",
			"Say \\{{self}} plainly.",
			"{{SELF}} and {{user}} stay literal.",
		]);
	});

	test("creates no greeting Message when the model Participant has no openings", () => {
		const conversation = createConversationModule(database);
		const snapshot = conversation.create(
			inputWith({
				participants: [
					{ definition: adHoc("Writer") },
					{ definition: adHoc("Maren Voss", []) },
				],
			}),
		);

		expect(snapshot.messages).toEqual([]);
		expect(snapshot.playable).toBe(true);
	});

	test("forks copy the authoritative Character Definition and record immutable provenance", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: {
				name: "Maren Voss",
				prompt: prompt({ identity: "Lighthouse archivist." }),
				openings: ["The lamp turns above you."],
			},
		});

		const conversation = createConversationModule(database);
		const snapshot = conversation.create(
			inputWith({
				participants: [
					{
						definition: {
							name: source.name,
							prompt: source.prompt,
							openings: source.openings,
						},
						sourceCharacterId: source.id,
					},
					{ definition: adHoc("Writer") },
				],
				control: { human: 1, model: 0 },
			}),
		);

		const fork = snapshot.cast.find((participant) => participant.name === "Maren Voss");
		expect(fork?.sourceCharacterId).toBe(source.id);
		expect(fork?.prompt).toEqual(source.prompt);
		expect(fork?.openings).toEqual(["The lamp turns above you."]);

		// The fork is independent: editing the source Character afterwards
		// leaves the Participant copy untouched.
		library.execute({
			type: "rename",
			characterId: source.id,
			expectedRevision: 0,
			name: "Renamed Voss",
		});
		const reread = conversation.getSnapshot(snapshot.id);
		expect(reread?.cast.find((participant) => participant.name === "Maren Voss")).toBeDefined();

		// Control can assign either seat to either Cast position.
		expect(reread?.control.modelParticipantId).toBe(fork?.id);
	});

	test("allows both seats to fork the same Character as separate Participants", () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: {
				name: "Twin Source",
				prompt: prompt(),
				openings: ["Only the model seat greets."],
			},
		});
		const forkDefinition = () => ({
			name: source.name,
			prompt: source.prompt,
			openings: source.openings,
		});

		const conversation = createConversationModule(database);
		const snapshot = conversation.create(
			inputWith({
				participants: [
					{ definition: forkDefinition(), sourceCharacterId: source.id },
					{ definition: forkDefinition(), sourceCharacterId: source.id },
				],
				control: { human: 0, model: 1 },
			}),
		);

		const [human, model] = snapshot.cast;
		expect(human?.id).not.toBe(model?.id);
		expect(human?.name).toBe(model?.name);
		expect(human?.sourceCharacterId).toBe(source.id);
		expect(model?.sourceCharacterId).toBe(source.id);
		expect(model?.prompt).toEqual(human?.prompt);

		// The greeting comes from the model seat's copy.
		expect(snapshot.messages[0]?.author?.participantId).toBe(model?.id);
	});

	test("normalizes Participant names while preserving case and Unicode", () => {
		const conversation = createConversationModule(database);
		const snapshot = conversation.create(
			inputWith({
				participants: [
					{ definition: adHoc("  JUNO Åshfeld-灯台  ") },
					{ definition: adHoc("Maren") },
				],
			}),
		);
		expect(snapshot.cast[0]?.name).toBe("JUNO Åshfeld-灯台");
	});

	test("rejects a blank Participant name or blank opening without partial writes", () => {
		const conversation = createConversationModule(database);
		expect(() =>
			conversation.create(
				inputWith({
					participants: [{ definition: adHoc("   ") }, { definition: adHoc("Maren") }],
				}),
			),
		).toThrow(InvalidConversationCreationError);
		expect(() =>
			conversation.create(
				inputWith({
					participants: [
						{ definition: adHoc("Writer") },
						{ definition: adHoc("Maren", ["Fine", "  "]) },
					],
				}),
			),
		).toThrow(InvalidConversationCreationError);

		expect(countRows(conversationTable)).toBe(0);
		expect(countRows(participantTable)).toBe(0);
		expect(countRows(participantPromptTable)).toBe(0);
		expect(countRows(participantOpeningTable)).toBe(0);
		expect(countRows(conversationControlTable)).toBe(0);
		expect(countRows(messageTable)).toBe(0);
	});

	test("requires two distinct Participants for native Control before commit", () => {
		const conversation = createConversationModule(database);

		// Same instance in both seats.
		expect(() =>
			conversation.create(
				inputWith({
					participants: [
						{ definition: adHoc("Solo") },
						{ definition: adHoc("Other") },
					],
					control: { human: 1, model: 1 },
				}),
			),
		).toThrow(InvalidConversationCreationError);

		// Seat referencing outside the Cast.
		expect(() =>
			conversation.create(inputWith({ control: { human: 0, model: 5 } })),
		).toThrow(InvalidConversationCreationError);

		expect(countRows(conversationTable)).toBe(0);
		expect(countRows(participantTable)).toBe(0);
	});

	test("preservation-style creation without Participants commits as incomplete", () => {
		const conversation = createConversationModule(database);
		const snapshot = conversation.create({
			name: "Imported Conversation",
			data: [{ namespace: "archive", key: "source", value: "chat-export.json" }],
			messages: [
				{
					timestamp: "2026-08-20T10:00:00Z",
					data: [{ namespace: "import.sillytavern", key: "author.name", value: "Maren" }],
					variants: [
						{ content: "Reply", timestamp: "2026-08-20T10:00:00Z", selected: true },
					],
				},
			],
		});

		expect(snapshot.revision).toBe(0);
		expect(snapshot.cast).toEqual([]);
		expect(snapshot.control).toEqual({
			humanParticipantId: null,
			modelParticipantId: null,
		});
		expect(snapshot.playable).toBe(false);
		expect(snapshot.capabilities.compose).toEqual({
			available: false,
			reason: "conversation-not-playable",
		});

		// Imported history carries no fabricated authorship or pair.
		const [first] = snapshot.messages;
		expect(first?.author).toEqual(null);
		expect(first?.historicalContext).toEqual(null);

		expect(conversation.getSnapshot(snapshot.id)).toEqual(snapshot);
	});

	test("structural constraints back the domain: unique Cast positions, ordered openings, distinct seats, and foreign keys", () => {
		const conversation = createConversationModule(database);
		const snapshot = conversation.create(inputWith());
		const db = drizzle(database);
		const humanId = snapshot.cast[0]?.id ?? 0;
		const modelId = snapshot.cast[1]?.id ?? 0;

		// Cast positions are unique per Conversation.
		expect(() =>
			db.insert(participantTable).values({
				conversation_id: snapshot.id,
				position: 1,
				name: "Clash",
			}).run(),
		).toThrow();

		// Opening order is unique per Participant; the model seat owns the
		// seeded openings in this fixture.
		expect(() =>
			db.insert(participantOpeningTable).values({
				participant_id: modelId,
				position: 1,
				content: "Clash",
			}).run(),
		).toThrow();

		// Each Control seat exists once; one Participant cannot hold both.
		expect(() =>
			db
				.insert(conversationControlTable)
				.values({ conversation_id: snapshot.id, seat: "human", participant_id: modelId })
				.run(),
		).toThrow();
		expect(() =>
			db
				.insert(conversationControlTable)
				.values({ conversation_id: snapshot.id, seat: "model", participant_id: humanId })
				.run(),
		).toThrow();
		expect(() =>
			db
				.insert(conversationControlTable)
				.values({ conversation_id: snapshot.id, seat: "audience", participant_id: modelId })
				.run(),
		).toThrow();

		// Foreign keys are enforced on provenance and authorship references.
		expect(() =>
			db
				.insert(participantTable)
				.values({
					conversation_id: snapshot.id,
					position: 3,
					name: "Ghost",
					source_character_id: 987654,
				})
				.run(),
		).toThrow();

		expect(() =>
			db
				.insert(messageTable)
				.values({
					conversation_id: snapshot.id,
					position: 1,
					timestamp: "2026-08-21T09:00:00Z",
					author_participant_id: 987654,
					author_name: "Ghost",
				})
				.run(),
		).toThrow();

		// The historical Control pair columns are set together or not at all.
		expect(() =>
			db
				.insert(messageTable)
				.values({
					conversation_id: snapshot.id,
					position: 2,
					timestamp: "2026-08-21T09:00:00Z",
					context_human_participant_id: humanId,
				})
				.run(),
		).toThrow();

		expect(countRows(characterTable)).toBe(0);
		expect(countRows(characterPromptTable)).toBe(0);
		expect(countRows(characterOpeningTable)).toBe(0);
	});
});
