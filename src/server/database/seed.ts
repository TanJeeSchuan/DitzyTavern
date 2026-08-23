// Test data generator. Run with `bun run db:seed`.
// Idempotent: does nothing if the tables already contain rows.
//
// Characters are created through the public Character Library seam so the
// seeded Definitions follow exactly the same rules as user-created ones.

import { drizzle } from "drizzle-orm/bun-sqlite";
import { createCharacterLibraryModule } from "../character-library";
import type { CharacterDefinition } from "../character-library";
import { openDatabase } from "./database";
import {
	characterTable,
	chatCharacterTable,
	chatTable,
} from "./schema";

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
			exampleDialogue: "<START>\n{{user}}: Is the river safe?\n{{char}}: The river is honest. The passengers rarely are.",
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

export const chats = [
	{
		name: "The Lantern House",
		creation_time: "2026-07-02T10:15:00.000Z",
		last_message_time: "2026-08-17T21:04:00.000Z",
		characterNames: ["Maren Voss", "Juno Ashfeld", "Theodora Kline"],
	},
	{
		name: "Salt and Ember",
		creation_time: "2026-07-19T18:30:00.000Z",
		last_message_time: "2026-08-18T09:12:00.000Z",
		characterNames: ["Silas Mercer", "Isolde Fairfax"],
	},
	{
		name: "The Cartographer's Daughter",
		creation_time: "2026-08-01T12:00:00.000Z",
		last_message_time: "2026-08-15T23:47:00.000Z",
		characterNames: ["Juno Ashfeld", "Isolde Fairfax", "Bram Okafor"],
	},
	{
		name: "Night Shift at the Observatory",
		creation_time: "2026-08-10T20:20:00.000Z",
		last_message_time: "2026-08-18T14:55:00.000Z",
		characterNames: ["Maren Voss", "Bram Okafor"],
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

		const insertedChats = db
			.insert(chatTable)
			.values(chats.map(({ characterNames: _characterNames, ...chat }) => chat))
			.returning({ id: chatTable.id, name: chatTable.name })
			.all();
		const chatIdByName = new Map(insertedChats.map((chat) => [chat.name, chat.id]));

		const memberships = chats.flatMap((chat) => {
			const chatId = chatIdByName.get(chat.name);
			if (!chatId) {
				throw new Error(`Missing inserted Chat: ${chat.name}`);
			}

			return chat.characterNames.map((characterName) => {
				const characterId = characterIdByName.get(characterName);
				if (!characterId) {
					throw new Error(`Missing inserted Character: ${characterName}`);
				}

				return { chat_id: chatId, character_id: characterId };
			});
		});
		db.insert(chatCharacterTable).values(memberships).all();

		log(
			`inserted ${characters.length} characters, ${chats.length} chats, ${memberships.length} chat_character rows`,
		);
	} finally {
		database.close();
	}
}

const isDirectRun = import.meta.main;
if (isDirectRun) {
	seed();
}
