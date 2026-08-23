// Test data generator. Run with `bun run db:seed`.
// Idempotent: does nothing if the tables already contain rows.
//
// Characters are created through the public Character Library seam and
// Conversations through the public native New Chat workflow, so seeded
// Definitions, Casts, Control assignments, and greeting history follow
// exactly the same rules as user-created data.

import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	type CharacterDefinition,
	createCharacterLibraryModule,
} from "../character-library";
import {
	createNativeConversation,
	type NewChatSeat,
} from "../workflows";
import { openDatabase } from "./database";
import { characterTable } from "./schema";

export interface SeedCharacter extends CharacterDefinition {
	pinned: boolean;
}

export const characters: SeedCharacter[] = [
	{
		name: "Maren Voss",
		pinned: true,
		prompt: {
			systemInstruction: "Keep responses literary and patient.",
			identity:
				"Maren Voss is a lighthouse archivist on the northern coast who catalogues shipwrecks and weather.",
			scenario: "A storm season has cut the lantern house off from town.",
			exampleDialogue:
				"<START>\n{{user}}: Who tends the light?\n{{char}}: I do, every night the fog lets me.",
			postHistoryInstruction: "",
		},
		openings: [
			"The lamp turns above you, steady as a heartbeat.",
			"The lamp turns above you, steady as a heartbeat.",
			"Rain writes on every window of the archive.",
		],
	},
	{
		name: "Juno Ashfeld",
		pinned: false,
		prompt: {
			systemInstruction: "",
			identity: "Juno Ashfeld repairs clocks in a workshop above the harbor.",
			scenario: "",
			exampleDialogue: "",
			postHistoryInstruction: "Favor precise, tactile details about machinery.",
		},
		openings: [],
	},
	{
		name: "Theodora Kline",
		pinned: true,
		prompt: {
			systemInstruction: "Answer as a careful field cartographer.",
			identity: "Theodora Kline maps coastlines that keep changing shape.",
			scenario: "The latest survey disagrees with every earlier chart.",
			exampleDialogue: "",
			postHistoryInstruction: "",
		},
		openings: ["You arrive as she pins a third map over the first two."],
	},
	{
		name: "Silas Mercer",
		pinned: false,
		prompt: {
			systemInstruction: "",
			identity: "Silas Mercer runs the last ferry that still crosses at night.",
			scenario: "The bridge upstream closed, and traffic found his boat again.",
			exampleDialogue:
				"<START>\n{{user}}: Is the river safe?\n{{char}}: The river is honest. The passengers rarely are.",
			postHistoryInstruction: "",
		},
		openings: ["The ferry bumps the pier twice before the rope catches."],
	},
	{
		name: "Isolde Fairfax",
		pinned: false,
		prompt: {
			systemInstruction: "Keep the tone warm and understated.",
			identity: "Isolde Fairfax restores murals in buildings nobody funds.",
			scenario: "Scaffolding hides half her work from the street.",
			exampleDialogue: "",
			postHistoryInstruction: "",
		},
		openings: ["Plaster dust settles on her shoulders like early snow."],
	},
	{
		name: "Bram Okafor",
		pinned: false,
		prompt: {
			systemInstruction: "",
			identity: "Bram Okafor records oral histories in a narrow shop of tape reels.",
			scenario: "",
			exampleDialogue: "",
			postHistoryInstruction: "",
		},
		openings: ["A reel spins down to silence before he speaks."],
	},
];

export interface AdHocPersona {
	name: string;
	prompt: CharacterDefinition["prompt"];
	openings: string[];
}

// Ad-hoc human personas. "Writer" is an ordinary possible Participant name;
// it carries no special behavior. The satisfies check keeps the concrete
// keys known to consumers (teardown and the seed itself) while validating
// the AdHocPersona contract.
export const adHocPersonas = {
	writer: {
		name: "Writer",
		prompt: {
			systemInstruction: "",
			identity:
				"The Writer guides the story from outside it and speaks only when needed.",
			scenario: "",
			exampleDialogue: "",
			postHistoryInstruction: "",
		},
		openings: [],
	},
	nightDesk: {
		name: "Night Desk",
		prompt: {
			systemInstruction: "",
			identity:
				"The Night Desk keeps the observatory logs and asks careful questions.",
			scenario: "",
			exampleDialogue: "",
			postHistoryInstruction: "",
		},
		openings: [],
	},
} satisfies Record<string, AdHocPersona>;

export interface SeedConversation {
	name: string;
	// Both Chat times derive from this base because native greetings carry no
	// historical timestamps of their own.
	createdAt: string;
	humanSeat: NewChatSeat | { persona: keyof typeof adHocPersonas };
	modelCharacterName: string;
}

export const conversations: SeedConversation[] = [
	{
		name: "The Lantern House",
		createdAt: "2026-07-02T10:15:00.000Z",
		humanSeat: { persona: "writer" },
		modelCharacterName: "Maren Voss",
	},
	{
		name: "Salt and Ember",
		createdAt: "2026-07-19T18:30:00.000Z",
		humanSeat: { persona: "nightDesk" },
		modelCharacterName: "Silas Mercer",
	},
	{
		name: "The Cartographer's Daughter",
		createdAt: "2026-08-01T12:00:00.000Z",
		humanSeat: { persona: "writer" },
		modelCharacterName: "Isolde Fairfax",
	},
	{
		name: "Night Shift at the Observatory",
		createdAt: "2026-08-10T20:20:00.000Z",
		humanSeat: { persona: "nightDesk" },
		modelCharacterName: "Theodora Kline",
	},
];

const definitionOf = (character: SeedCharacter): CharacterDefinition => ({
	name: character.name,
	prompt: character.prompt,
	openings: character.openings,
});

export function seed(databasePath?: string) {
	const database = openDatabase({ path: databasePath });
	const db = drizzle(database);
	const library = createCharacterLibraryModule(database);
	const log = (message: string) => console.log(`[seed] ${message}`);

	try {
		const existing = db.select().from(characterTable).limit(1).all();
		if (existing.length > 0) {
			log("database already contains data; skipping seed");
			return;
		}

		const characterIdByName = new Map<string, number>();
		for (const character of characters) {
			const created = library.execute({
				type: "create",
				definition: definitionOf(character),
			});
			if (character.pinned) {
				library.execute({
					type: "set-pinned",
					characterId: created.id,
					expectedRevision: created.revision,
					pinned: true,
				});
			}
			characterIdByName.set(character.name, created.id);
		}

		// A fork seat always checks the authoritative revision server-side;
		// the expected revision here mirrors what a client would have read.
		const forkSeat = (characterName: string): NewChatSeat => {
			const characterId = characterIdByName.get(characterName);
			if (characterId === undefined) {
				throw new Error(`Missing seeded Character: ${characterName}`);
			}
			const snapshot = library.get(characterId);
			if (snapshot === undefined) {
				throw new Error(`Seeded Character not readable: ${characterName}`);
			}
			return {
				type: "character",
				characterId,
				expectedRevision: snapshot.revision,
			};
		};
		const personaSeat = (
			persona: keyof typeof adHocPersonas,
		): NewChatSeat => ({
			type: "adhoc",
			definition: adHocPersonas[persona],
		});

		for (const conversation of conversations) {
			const humanSeat =
				"persona" in conversation.humanSeat
					? personaSeat(conversation.humanSeat.persona)
					: conversation.humanSeat;
			createNativeConversation(database, {
				name: conversation.name,
				humanSeat,
				modelSeat: forkSeat(conversation.modelCharacterName),
				createdAt: conversation.createdAt,
			});
		}

		log(
			`inserted ${characters.length} characters and ${conversations.length} playable Conversations`,
		);
	} finally {
		database.close();
	}
}

const isDirectRun = import.meta.main;
if (isDirectRun) {
	seed();
}
