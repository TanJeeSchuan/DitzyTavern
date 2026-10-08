import { createConversationWithHistory } from "../test-fixtures/conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createLorebookRoutes } from "./lorebook-routes";
import type { Lorebook, LorebookCommand } from "../../shared/contract/lorebook";
import { createCharacterLibraryModule } from "../character-library";

const request = (path: string, init?: RequestInit) =>
	new Request(`http://localhost${path}`, {
		headers: { "content-type": "application/json", ...init?.headers },
		...init,
	});

const postCommand = (app: ReturnType<typeof createLorebookRoutes>, command: LorebookCommand) =>
	app.handle(request("/api/lorebooks/commands", { method: "POST", body: JSON.stringify(command) }));

// SAFETY: each caller has already asserted the route status and owns the expected response shape.
const readBody = async <T>(response: Response): Promise<T> => await response.json() as T;

describe("Lorebook library transport", () => {
	let database: Database;
	let app: ReturnType<typeof createLorebookRoutes>;

	beforeEach(() => {
		database = openObservedDatabase();
		app = createLorebookRoutes(database);
	});
	afterEach(() => database.close());

	test("creates, edits, orders and toggles authored entries", async () => {
		const created = await postCommand(app, { type: "create", name: "World", description: "Canon" });
		expect(created.status).toBe(200);
		const book = (await readBody<{ book: Lorebook }>(created)).book;
		expect(book).toMatchObject({ id: 1, name: "World", description: "Canon", revision: 0, entries: [] });

		const entry = {
			title: "Harbor",
			content: "The harbor is old.",
			keywords: ["harbor"],
			semanticTriggers: ["ships arrive"],
			matchOperator: "and" as const,
			always: false,
			requireAny: [],
			requireAll: [],
			excludeAny: [],
			excludeAll: [],
			caseSensitive: false,
			wholeWord: true,
			keywordMode: "literal" as const,
			regexFlags: "",
			
			priority: 4,
			enabled: true,
		};
		const added = await postCommand(app, { type: "save-entry", bookId: 1, expectedRevision: 0, entry });
		expect(added.status).toBe(200);
		const addedBook = (await readBody<{ book: Lorebook }>(added)).book;
		expect(addedBook.entries[0]).toMatchObject({ position: 1, ...entry });

		const second = await postCommand(app, {
			type: "save-entry",
			bookId: 1,
			expectedRevision: 1,
			entry: { ...entry, title: "Tower", content: "The tower watches the harbor.", keywords: ["tower"] },
		});
		const secondBook = (await readBody<{ book: Lorebook }>(second)).book;
		const reordered = await postCommand(app, {
			type: "reorder-entry", bookId: 1, entryId: secondBook.entries[1].id,
			expectedRevision: 2, toPosition: 1,
		});
		expect(reordered.status).toBe(200);
		const reorderedBook = (await readBody<{ book: Lorebook }>(reordered)).book;
		expect(reorderedBook.entries.map((item) => item.title)).toEqual(["Tower", "Harbor"]);

		const disabled = await postCommand(app, {
			type: "set-entry-enabled", bookId: 1, entryId: reorderedBook.entries[0].id,
			expectedRevision: 3, enabled: false,
		});
		expect((await readBody<{ book: Lorebook }>(disabled)).book.entries[0].enabled).toBe(false);
	});

	test("rejects stale edits without mutating the authoritative book", async () => {
		const created = await postCommand(app, { type: "create", name: "World" });
		const renamed = await postCommand(app, {
			type: "update-book", bookId: 1, expectedRevision: 0, name: "Updated", description: "" ,
		});
		expect(renamed.status).toBe(200);
		const stale = await postCommand(app, {
			type: "update-book", bookId: 1, expectedRevision: 0, name: "Wrong", description: "changed",
		});
		expect(stale.status).toBe(409);
		expect(await stale.json()).toMatchObject({ outcome: "conflict", expectedRevision: 0, actualRevision: 1, currentBook: { name: "Updated" } });
		expect(await (await app.handle(request("/api/lorebooks/1"))).json()).toMatchObject({ name: "Updated", description: "" });
		void created;
	});

	test("round trips native fields into independent identities", async () => {
		const native = {
			name: "Imported",
			description: "A book",
			entries: [{
				title: "Entry", content: "Literal {{macro}}", keywords: ["key"], semanticTriggers: ["meaning"],
				matchOperator: "or" as const, always: false, requireAny: [], requireAll: [], excludeAny: [], excludeAll: [],
				caseSensitive: true, wholeWord: false, keywordMode: "regex" as const, regexFlags: "i", 
				priority: 0, enabled: false,
			}],
		};
		const imported = await app.handle(request("/api/lorebooks/import", { method: "POST", body: JSON.stringify(native) }));
		expect(imported.status).toBe(200);
		const original = (await readBody<{ book: Lorebook }>(imported)).book;
		const exported = await app.handle(request(`/api/lorebooks/${original.id}/export`));
		expect(await exported.json()).toEqual(native);
		const duplicated = await postCommand(app, { type: "duplicate", bookId: original.id, expectedRevision: 0 });
		expect(duplicated.status).toBe(200);
		const copy = (await readBody<{ book: Lorebook }>(duplicated)).book;
		expect(copy.id).not.toBe(original.id);
		expect(copy.entries[0].id).not.toBe(original.entries[0].id);
	});

	test("imports supported SillyTavern fields and reports unsupported behavior", async () => {
		const response = await app.handle(request("/api/lorebooks/import/sillytavern", {
			method: "POST",
			body: JSON.stringify({ source: {
				name: "ST",
				entries: [{ comment: "Fact", content: "Keep {{literal}}", key: ["port"], constant: false, enabled: false, vectorized: true, order: 7 }],
			} }),
		}));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			outcome: "applied",
			book: { name: "ST", entries: [{ title: "Fact", content: "Keep {{literal}}", keywords: ["port"], enabled: false, semanticTriggers: [] }] },
			warnings: [
				"Entry 1 uses unsupported full-content semantic matching; authored Keywords remain usable.",
				"Entry 1 contains unsupported macros; they remain literal.",
			],
		});
	});

	test("reports each unsupported SillyTavern behavior separately", async () => {
		const response = await app.handle(request("/api/lorebooks/import/sillytavern", {
			method: "POST",
			body: JSON.stringify({ source: {
				name: "Unsupported",
				entries: [{
					content: "Fact {{macro}}", key: ["port"], recursion: true, delay: 2, sticky: true,
					probability: 50, useProbability: true, group: "harbor", position: 3,
				}],
			} }),
		}));
		expect(response.status).toBe(200);
		// SAFETY: the successful route response is the public import result and includes warnings.
		const body = await response.json() as { warnings: string[] };
		expect(body.warnings).toEqual([
			"Entry 1 uses unsupported recursion behavior; recursion was not imported.",
			"Entry 1 uses unsupported timing behavior; sticky, delay and cooldown settings were not imported.",
			"Entry 1 uses unsupported probability behavior; probability settings were not imported.",
			"Entry 1 uses unsupported group behavior; group settings were not imported.",
			"Entry 1 uses unsupported placement behavior; source placement settings were not imported.",
			"Entry 1 contains unsupported macros; they remain literal.",
		]);
	});

	test("maps native SillyTavern disable and secondary-key fields", async () => {
		const response = await app.handle(request("/api/lorebooks/import/sillytavern", {
			method: "POST",
			body: JSON.stringify({ source: {
				name: "Native ST",
				entries: [{
					comment: "All secondary keys", content: "Fact", key: ["primary"], keysecondary: ["required one", "required two"],
					selective: true, selectiveLogic: 1, constant: false, disable: true, order: 9,
				}],
			} }),
		}));
		expect(response.status).toBe(200);
		expect((await response.json())).toMatchObject({
			book: {
				entries: [{
					matchOperator: "or",
					requireAny: [],
					requireAll: ["required one", "required two"],
					enabled: false,
					priority: 9,
				}],
			},
		});
	});

	test("preserves SillyTavern slash-delimited keyword regexes", async () => {
		const response = await app.handle(request("/api/lorebooks/import/sillytavern", {
			method: "POST",
			body: JSON.stringify({ source: { name: "Regex", entries: [{ content: "Fact", key: ["/harbor/i"] }] } }),
		}));
		expect(response.status).toBe(200);
		expect((await response.json())).toMatchObject({ book: { entries: [{ keywords: ["/harbor/i"], keywordMode: "regex", regexFlags: "" }] } });
	});

	test("rejects malformed SillyTavern entry collections atomically", async () => {
		const response = await app.handle(request("/api/lorebooks/import/sillytavern", {
			method: "POST",
			body: JSON.stringify({ source: { name: "Broken", entries: null } }),
		}));
		expect(response.status).toBe(422);
		expect(await (await app.handle(request("/api/lorebooks"))).json()).toEqual({ books: [] });
	});

	test("invalid native imports do not partially create a book", async () => {
		const response = await app.handle(request("/api/lorebooks/import", {
			method: "POST",
			body: JSON.stringify({ name: "Broken", description: "", entries: [{ title: "x", content: "x", keywords: [], semanticTriggers: [], matchOperator: "or", always: false, requireAny: [], requireAll: [], excludeAny: [], excludeAll: [], caseSensitive: false, wholeWord: true, keywordMode: "regex", regexFlags: "invalid flag", priority: 0, enabled: true }] }),
		}));
		expect(response.status).toBe(422);
		expect(await (await app.handle(request("/api/lorebooks"))).json()).toEqual({ books: [] });
	});

	test("reads attachment eligibility and Chat Lore settings", async () => {
		const created = await postCommand(app, { type: "create", name: "World" });
		const conversation = createConversationWithHistory(database, {
			name: "Story",
			participants: [
				{ definition: { name: "Writer", prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
				{ definition: { name: "Narrator", prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const initial = await app.handle(request(`/api/lorebooks/attachments?conversationId=${conversation.id}`));
		expect(initial.status).toBe(200);
		expect(await initial.json()).toMatchObject({ conversationId: conversation.id, revision: 0, scanDepth: 4, allowance: 2048, attachments: [] });
		await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify({ type: "attach-chat", conversationId: conversation.id, bookId: 1, expectedRevision: 0 }) }));
		await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify({ type: "save-settings", conversationId: conversation.id, expectedRevision: 1, scanDepth: 2, allowance: 900 }) }));
		const updated = await app.handle(request(`/api/lorebooks/attachments?conversationId=${conversation.id}`));
		expect(await updated.json()).toMatchObject({ scanDepth: 2, allowance: 900, attachments: [{ bookId: 1, owner: "conversation", scope: "chat", enabled: true, eligible: true, reason: "eligible" }] });
		void created;
	});

	test("tests an unattached Lorebook independently of the selected preset", async () => {
		const created = await postCommand(app, { type: "create", name: "World" });
		const book = (await readBody<{ book: Lorebook }>(created)).book;
		await postCommand(app, {
			type: "save-entry", bookId: book.id, expectedRevision: book.revision,
			entry: {
				title: "Harbor", content: "The harbor is old.", keywords: ["harbor"], semanticTriggers: ["ships arrive"],
				matchOperator: "or", always: false, requireAny: [], requireAll: [], excludeAny: [], excludeAll: [],
				caseSensitive: false, wholeWord: true, keywordMode: "literal", regexFlags: "", 
				priority: 0, enabled: true,
			},
		});
		createConversationWithHistory(database, {
			name: "Story",
			participants: [
				{ definition: { name: "Writer", prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
				{ definition: { name: "Narrator", prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		database.exec("UPDATE prompt_preset_block SET enabled = 0 WHERE reference = 'lore'");
		let embeddingCalls = 0;
		const guardedApp = createLorebookRoutes(database, { fetch: async () => { embeddingCalls += 1; throw new Error("embedding should not run"); } });
		const response = await guardedApp.handle(request("/api/lorebooks/match-test", { method: "POST", body: JSON.stringify({ bookId: book.id, writing: "Ships arrive at the harbor." }) }));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ mode: "keyword-fallback", scan: [{ id: null, content: "Ships arrive at the harbor." }], matches: [{ title: "Harbor", active: true }] });
		expect(embeddingCalls).toBe(0);
		const noMatch = await guardedApp.handle(request("/api/lorebooks/match-test", { method: "POST", body: JSON.stringify({ bookId: book.id, writing: "An empty desert." }) }));
		expect(await noMatch.json()).toMatchObject({ matches: [{ title: "Harbor", active: false }] });
	});

	test("reports every attachment before deletion and cascades them on confirmation", async () => {
		await postCommand(app, { type: "create", name: "World" });
		const character = createCharacterLibraryModule(database).execute({
			type: "create",
			definition: {
				name: "Archivist",
				prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" },
				openings: [],
			},
		});
		const conversation = createConversationWithHistory(database, {
			name: "Story",
			participants: [
				{ definition: { name: "Writer", prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
				{ definition: { name: "Narrator", prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const participantId = conversation.cast[0]?.id;
		if (participantId === undefined) throw new Error("Conversation participant was not created.");
		for (const command of [
			{ type: "attach-character", characterId: character.id, bookId: 1, expectedRevision: 0, scope: "cast" },
			{ type: "attach-participant", participantId, bookId: 1, expectedRevision: 0, scope: "controlled-participant" },
			{ type: "attach-chat", conversationId: conversation.id, bookId: 1, expectedRevision: 1 },
		] as const) {
			const response = await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify(command) }));
			expect(response.status).toBe(200);
		}
		const impact = await app.handle(request("/api/lorebooks/1/attachments"));
		expect(impact.status).toBe(200);
		expect(await impact.json()).toMatchObject({ bookId: 1, attachments: [
			{ owner: "character", ownerId: character.id, ownerName: "Archivist", scope: "cast" },
			{ owner: "participant", ownerId: participantId, ownerName: "Writer", scope: "controlled-participant" },
			{ owner: "conversation", ownerId: conversation.id, ownerName: "Story", scope: "chat" },
		] });
		const deleted = await postCommand(app, { type: "delete", bookId: 1, expectedRevision: 0 });
		expect(deleted.status).toBe(200);
		expect((await app.handle(request("/api/lorebooks/1/attachments"))).status).toBe(404);
	});

	test("reads Character and Participant attachment lists for management", async () => {
		await postCommand(app, { type: "create", name: "World" });
		const character = createCharacterLibraryModule(database).execute({
			type: "create",
			definition: {
				name: "Archivist",
				prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" },
				openings: [],
			},
		});
		const conversation = createConversationWithHistory(database, {
			name: "Story",
			participants: [
				{ definition: { name: "Writer", prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
				{ definition: { name: "Narrator", prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const participantId = conversation.cast[0]?.id;
		if (participantId === undefined) throw new Error("Conversation participant was not created.");
		await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify({ type: "attach-character", characterId: character.id, bookId: 1, expectedRevision: 0, scope: "cast", enabled: false }) }));
		await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify({ type: "attach-participant", participantId, bookId: 1, expectedRevision: 0, scope: "controlled-participant" }) }));
		const characterState = await app.handle(request(`/api/lorebooks/attachments/character?ownerId=${character.id}`));
		const participantState = await app.handle(request(`/api/lorebooks/attachments/participant?ownerId=${participantId}`));
		expect(await characterState.json()).toMatchObject({ owner: "character", ownerId: character.id, attachments: [{ bookId: 1, scope: "cast", enabled: false }] });
		expect(await participantState.json()).toMatchObject({ owner: "participant", ownerId: participantId, attachments: [{ bookId: 1, scope: "controlled-participant", enabled: true }] });
	});

	test("detaches only the requested Character and Participant attachment scope", async () => {
		await postCommand(app, { type: "create", name: "World" });
		const character = createCharacterLibraryModule(database).execute({
			type: "create",
			definition: {
				name: "Archivist",
				prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" },
				openings: [],
			},
		});
		const conversation = createConversationWithHistory(database, {
			name: "Story",
			participants: [
				{ definition: { name: "Writer", prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
				{ definition: { name: "Narrator", prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const participantId = conversation.cast[0]?.id;
		if (participantId === undefined) throw new Error("Conversation participant was not created.");

		for (const command of [
			{ type: "attach-character", characterId: character.id, bookId: 1, expectedRevision: 0, scope: "cast" },
			{ type: "attach-character", characterId: character.id, bookId: 1, expectedRevision: 1, scope: "controlled-participant", enabled: false },
		] as const) {
			expect((await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify(command) }))).status).toBe(200);
		}
		const characterDetach = await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify({ type: "detach-character", characterId: character.id, bookId: 1, scope: "cast", expectedRevision: 2 }) }));
		expect(characterDetach.status).toBe(200);
		expect(await (await app.handle(request(`/api/lorebooks/attachments/character?ownerId=${character.id}`))).json()).toMatchObject({ attachments: [{ bookId: 1, scope: "controlled-participant", enabled: false }] });

		for (const command of [
			{ type: "attach-participant", participantId, bookId: 1, expectedRevision: 0, scope: "cast" },
			{ type: "attach-participant", participantId, bookId: 1, expectedRevision: 1, scope: "controlled-participant", enabled: false },
		] as const) {
			expect((await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify(command) }))).status).toBe(200);
		}
		const participantDetach = await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify({ type: "detach-participant", participantId, bookId: 1, scope: "cast", expectedRevision: 2 }) }));
		expect(participantDetach.status).toBe(200);
		expect(await (await app.handle(request(`/api/lorebooks/attachments/participant?ownerId=${participantId}`))).json()).toMatchObject({ attachments: [{ bookId: 1, scope: "controlled-participant", enabled: false }] });
	});

	test("rejects stale attachment and Chat Lore settings writes atomically", async () => {
		await postCommand(app, { type: "create", name: "World" });
		const character = createCharacterLibraryModule(database).execute({
			type: "create",
			definition: {
				name: "Archivist",
				prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" },
				openings: [],
			},
		});
		const conversation = createConversationWithHistory(database, {
			name: "Story",
			participants: [
				{ definition: { name: "Writer", prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
				{ definition: { name: "Narrator", prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const initialChat = await app.handle(request(`/api/lorebooks/attachments?conversationId=${conversation.id}`));
		const initialChatState = await readBody<{ revision: number }>(initialChat);
		const attached = await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify({ type: "attach-chat", conversationId: conversation.id, bookId: 1, expectedRevision: initialChatState.revision }) }));
		expect(attached.status).toBe(200);
		const staleSettings = await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify({ type: "save-settings", conversationId: conversation.id, expectedRevision: initialChatState.revision, scanDepth: 1, allowance: 1 }) }));
		expect(staleSettings.status).toBe(409);
		expect(await staleSettings.json()).toMatchObject({ outcome: "conflict", expectedRevision: 0, actualRevision: 1, currentConversation: { id: conversation.id, name: "Story", revision: 1 } });
		const missingParticipant = await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify({ type: "attach-participant", participantId: 9999, bookId: 1, expectedRevision: 1, scope: "cast" }) }));
		expect(missingParticipant.status).toBe(404);

		const staleCharacter = await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify({ type: "attach-character", characterId: character.id, bookId: 1, expectedRevision: 0, scope: "cast" }) }));
		expect(staleCharacter.status).toBe(200);
		const staleDetach = await app.handle(request("/api/lorebooks/attachments/commands", { method: "POST", body: JSON.stringify({ type: "detach-character", characterId: character.id, bookId: 1, scope: "cast", expectedRevision: 0 }) }));
		expect(staleDetach.status).toBe(409);
		expect(await staleDetach.json()).toMatchObject({ outcome: "conflict", expectedRevision: 0, actualRevision: 1, currentState: { revision: 1, attachments: [{ bookId: 1 }] } });
	});
});
