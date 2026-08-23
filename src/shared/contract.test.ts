import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openDatabase } from "../server/database/database";
import {
	createCharacterLibraryModule,
	type CharacterDefinition,
	type CharacterLibraryCommand,
} from "../server/character-library";
import { createConversationModule } from "../server/conversation";
import type { ConversationAction } from "../server/conversation";
import { createNativeConversation } from "../server/workflows";
import {
	createCharacterLibraryRoutes,
	createConversationRoutes,
	createNativeConversationRoutes,
} from "./contract";

const definition = (overrides: Partial<CharacterDefinition> = {}): CharacterDefinition => ({
	name: "Maren Voss",
	prompt: {
		systemInstruction: "System text.",
		identity: "Identity text.",
		scenario: "",
		exampleDialogue: "",
		postHistoryInstruction: "",
	},
	openings: [],
	...overrides,
});

// Transport tests cover request/response contracts and typed error mapping
// only; the domain matrix lives behind the Character Library seam tests.
describe("Character Library transport adapters", () => {
	let database: Database;
	let app: ReturnType<typeof createCharacterLibraryRoutes>;

	const post = async (command: CharacterLibraryCommand) =>
		app.handle(
			new Request("http://localhost/api/characters/commands", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(command),
			}),
		);

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		app = createCharacterLibraryRoutes(database);
	});

	afterEach(() => {
		database.close();
	});

	test("lists Characters in library order", async () => {
		await post({ type: "create", definition: definition({ name: "Zebra" }) });
		const alpha = await post({
			type: "create",
			definition: definition({ name: "Alpha" }),
		});
		const alphaCharacter = (await alpha.json()).character;

		await post({
			type: "set-pinned",
			characterId: alphaCharacter.id,
			expectedRevision: 0,
			pinned: true,
		});

		const response = await app.handle(new Request("http://localhost/api/characters"));
		expect(response.status).toBe(200);
		const { characters } = await response.json();
		expect(characters).toHaveLength(2);
	});

	test("returns a Character detail and a typed not-found outcome", async () => {
		const created = await (
			await post({ type: "create", definition: definition() })
		).json();
		const characterId = created.character.id;

		const found = await app.handle(
			new Request(`http://localhost/api/characters/${characterId}`),
		);
		expect(found.status).toBe(200);
		expect((await found.json()).openings).toEqual([]);

		const missing = await app.handle(
			new Request("http://localhost/api/characters/999999"),
		);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ outcome: "not-found" });
	});

	test("applies commands, propagates revisions, and maps conflicts to the typed 409 payload", async () => {
		const created = await (
			await post({ type: "create", definition: definition() })
		).json();

		const applied = await post({
			type: "rename",
			characterId: created.character.id,
			expectedRevision: 0,
			name: "Renamed",
		});
		expect(applied.status).toBe(200);
		const appliedBody = await applied.json();
		expect(appliedBody.outcome).toBe("applied");
		expect(appliedBody.character.revision).toBe(1);

		const stale = await post({
			type: "rename",
			characterId: created.character.id,
			expectedRevision: 0,
			name: "Stale",
		});
		expect(stale.status).toBe(409);
		const conflict = await stale.json();
		expect(conflict.outcome).toBe("conflict");
		expect(conflict.expectedRevision).toBe(0);
		expect(conflict.actualRevision).toBe(1);
		expect(conflict.currentCharacter.name).toBe("Renamed");
		expect(conflict.currentCharacter.revision).toBe(1);
	});

	test("maps validation failures and missing Characters to their typed outcomes", async () => {
		const invalid = await post({
			type: "create",
			definition: definition({ name: "   ", openings: ["ok"] }),
		});
		expect(invalid.status).toBe(422);
		const invalidBody = await invalid.json();
		expect(invalidBody.outcome).toBe("invalid");
		expect(invalidBody.reason).toBe("A Character name is required.");

		const missing = await post({
			type: "set-pinned",
			characterId: 123456,
			expectedRevision: 0,
			pinned: true,
		});
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ outcome: "not-found" });
	});
});

// Transport tests for the native New Chat workflow cover the request and
// response contract plus typed error mapping; workflow behavior lives
// behind its own interface tests.
describe("Native Conversation transport adapter", () => {
	let database: Database;
	let app: ReturnType<typeof createNativeConversationRoutes>;

	interface AdHocSeatPayload {
		type: "adhoc";
		definition: {
			name: string;
			prompt: {
				systemInstruction: string;
				identity: string;
				scenario: string;
				exampleDialogue: string;
				postHistoryInstruction: string;
			};
			openings: string[];
		};
	}

	type NewChatSeatPayload =
		| AdHocSeatPayload
		| { type: "character"; characterId: number; expectedRevision: number };

	interface NativeCreationBody {
		name: string;
		humanSeat: NewChatSeatPayload;
		modelSeat: NewChatSeatPayload;
	}

	const post = (body: NativeCreationBody) =>
		app.handle(
			new Request("http://localhost/api/conversations/native", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		app = createNativeConversationRoutes(database);
	});

	afterEach(() => {
		database.close();
	});

	const adHocSeat = (name = "Writer"): AdHocSeatPayload => ({
		type: "adhoc",
		definition: {
			name,
			prompt: {
				systemInstruction: "",
				identity: "",
				scenario: "",
				exampleDialogue: "",
				postHistoryInstruction: "",
			},
			openings: [],
		},
	});

	test("creates a playable native Conversation and returns its snapshot", async () => {
		const response = await post({
			name: "Transport Chat",
			humanSeat: adHocSeat("Writer"),
			modelSeat: adHocSeat("Maren Voss"),
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.outcome).toBe("created");
		expect(body.conversation.playable).toBe(true);
		expect(body.conversation.cast.map((p: { name: string }) => p.name)).toEqual([
			"Writer",
			"Maren Voss",
		]);
		expect(body.conversation.control.humanParticipantId).toBe(
			body.conversation.cast[0]?.id,
		);
	});

	test("maps a stale fork source to the typed conflict payload", async () => {
		const library = createCharacterLibraryModule(database);
		const source = library.execute({ type: "create", definition: definition() });
		await library.execute({
			type: "rename",
			characterId: source.id,
			expectedRevision: 0,
			name: "Renamed Voss",
		});

		const response = await post({
			name: "Stale Fork",
			humanSeat: adHocSeat(),
			modelSeat: {
				type: "character",
				characterId: source.id,
				expectedRevision: 0,
			},
		});
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.outcome).toBe("conflict");
		expect(body.expectedRevision).toBe(0);
		expect(body.actualRevision).toBe(1);
		expect(body.currentCharacter.name).toBe("Renamed Voss");
	});

	test("maps a missing fork source and invalid Definitions to typed outcomes", async () => {
		const missing = await post({
			name: "Ghost",
			humanSeat: adHocSeat(),
			modelSeat: { type: "character", characterId: 424242, expectedRevision: 0 },
		});
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ outcome: "not-found" });

		const invalid = await post({
			name: "Invalid",
			humanSeat: adHocSeat(),
			modelSeat: {
				type: "adhoc",
				definition: { ...adHocSeat().definition, openings: ["   "] },
			},
		});
		expect(invalid.status).toBe(422);
		const body = await invalid.json();
		expect(body.outcome).toBe("invalid");
		expect(body.reason).toContain("blank opening");
	});
});

// Transport tests for the Cast/Control surface mirror the Conversation seam:
// request/response contracts, revision propagation, and typed error mapping.
// The domain matrix lives behind the seam's own interface tests.
describe("Conversation Cast/Control transport adapters", () => {
	let database: Database;
	let app: ReturnType<typeof createConversationRoutes>;

	interface AddCharacterToCastPayload {
		expectedConversationRevision: number;
		characterId: number;
		expectedCharacterRevision: number;
	}

	const command = (
		conversationId: number,
		expectedRevision: number,
		action: ConversationAction,
	) =>
		app.handle(
			new Request(
				`http://localhost/api/conversations/${conversationId}/commands`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ expectedRevision, action }),
				},
			),
		);

	const addCharacter = (
		conversationId: number,
		body: AddCharacterToCastPayload,
	) =>
		app.handle(
			new Request(
				`http://localhost/api/conversations/${conversationId}/cast/characters`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(body),
				},
			),
		);

	const adHocDefinition = (name: string, openings: string[] = []) => ({
		name,
		prompt: {
			systemInstruction: "",
			identity: "",
			scenario: "",
			exampleDialogue: "",
			postHistoryInstruction: "",
		},
		openings,
	});

	const setupConversation = () => {
		const created = createNativeConversation(database, {
			name: "Transport Chat",
			humanSeat: {
				type: "adhoc",
				definition: adHocDefinition("Writer"),
			},
			modelSeat: {
				type: "adhoc",
				definition: adHocDefinition("Maren Voss", ["Hello"]),
			},
		});
		return {
			id: created.id,
			humanId: created.cast[0]?.id ?? 0,
			modelId: created.cast[1]?.id ?? 0,
		};
	};

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		app = createConversationRoutes(database);
	});

	afterEach(() => {
		database.close();
	});

	test("reads a Conversation snapshot with derived Cast and Control fields", async () => {
		const { id } = setupConversation();
		const response = await app.handle(
			new Request(`http://localhost/api/conversations/${id}`),
		);
		expect(response.status).toBe(200);
		const snapshot = await response.json();
		expect(snapshot.cast).toHaveLength(2);
		expect(snapshot.controlValidity).toEqual({ valid: true, reason: null });
		expect(snapshot.playable).toBe(true);
		expect(snapshot.cast[0]?.duplicateLabel).toBe("Writer");
		expect(snapshot.cast[0]?.removal).toEqual({
			eligible: false,
			reason: "control-assigned",
			deletionMode: null,
			affectedGenerationCount: 0,
		});

		const missing = await app.handle(
			new Request("http://localhost/api/conversations/999999"),
		);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ outcome: "not-found" });
	});

	test("applies Cast commands and propagates the Conversation revision", async () => {
		const { id } = setupConversation();
		const applied = await command(id, 0, {
			type: "add-participant",
			definition: adHocDefinition("Juno Ashfeld"),
		});
		expect(applied.status).toBe(200);
		const body = await applied.json();
		expect(body.outcome).toBe("applied");
		expect(body.conversation.revision).toBe(1);
		expect(body.conversation.cast.map((p: { name: string }) => p.name)).toEqual([
			"Writer",
			"Maren Voss",
			"Juno Ashfeld",
		]);
	});

	test("the raw command route never accepts client-supplied Character provenance", async () => {
		// Character-to-Cast forks must flow through the workflow route so
		// the source Character and destination Conversation revisions are
		// checked server-side. A forged sourceCharacterId on the raw command
		// is stripped by the transport schema and never reaches the domain.
		const { id } = setupConversation();
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: definition({ name: "Fork Source" }),
		});

		// SAFETY: this payload deliberately carries a field the transport
		// schema does not declare; the adapter must strip it instead of
		// honoring forged provenance.
		const forgedPayload = {
			type: "add-participant",
			definition: adHocDefinition("Claimed Fork", ["Fabricated definition"]),
			sourceCharacterId: source.id,
		} as ConversationAction;
		const forged = await command(id, 0, forgedPayload);
		expect(forged.status).toBe(200);
		const body = await forged.json();
		const appended = body.conversation.cast.at(-1);
		expect(appended?.name).toBe("Claimed Fork");
		expect(appended?.sourceCharacterId).toBeNull();
		expect(appended?.sourceCharacterName).toBeNull();
	});

	test("maps a stale command to the typed conflict with the current snapshot", async () => {
		const { id } = setupConversation();
		await command(id, 0, {
			type: "add-participant",
			definition: adHocDefinition("Juno Ashfeld"),
		});

		const stale = await command(id, 0, {
			type: "add-participant",
			definition: adHocDefinition("Stale"),
		});
		expect(stale.status).toBe(409);
		const body = await stale.json();
		expect(body.outcome).toBe("conflict");
		expect(body.expectedRevision).toBe(0);
		expect(body.actualRevision).toBe(1);
		expect(body.currentConversation.cast).toHaveLength(3);
	});

	test("maps validation failures and missing Conversations to typed outcomes", async () => {
		const { id, humanId } = setupConversation();
		const invalid = await command(id, 0, {
			type: "rename-participant",
			participantId: humanId,
			name: "   ",
		});
		expect(invalid.status).toBe(422);
		const invalidBody = await invalid.json();
		expect(invalidBody.outcome).toBe("invalid");
		expect(invalidBody.reason).toContain("name");

		const missing = await command(424242, 0, {
			type: "add-participant",
			definition: adHocDefinition("Ghost"),
		});
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({ outcome: "not-found" });
	});

	test("maps removal of a seated Participant to the typed not-removable outcome", async () => {
		const { id, humanId } = setupConversation();
		const response = await command(id, 0, {
			type: "remove-participant",
			participantId: humanId,
		});
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.outcome).toBe("not-removable");
		expect(body.reason).toBe("control-assigned");

		// The rejected removal committed nothing.
		const snapshot = await app.handle(
			new Request(`http://localhost/api/conversations/${id}`),
		);
		expect((await snapshot.json()).revision).toBe(0);
	});

	test("remove-participant applies with the derived impact and display state on the wire", async () => {
		const { id, modelId } = setupConversation();

		const withThird = await (
			await command(id, 0, {
				type: "add-participant",
				definition: adHocDefinition("Juno Ashfeld"),
			})
		).json();
		const junoId = withThird.conversation.cast.at(-1)?.id;
		const replaced = await (
			await command(id, 1, {
				type: "assign-control",
				seat: "model",
				participantId: junoId,
			})
		).json();

		// The wire snapshot exposes the derived removal impact: the displaced
		// model Participant is tombstoned (the greeting still refers to it)
		// and that greeting currently loses its ability to regenerate.
		const displaced = replaced.conversation.cast.find(
			(participant: { id: number }) => participant.id === modelId,
		);
		expect(displaced?.removal).toEqual({
			eligible: true,
			reason: null,
			deletionMode: "tombstone",
			affectedGenerationCount: 1,
		});

		const removed = await (
			await command(id, 2, {
				type: "remove-participant",
				participantId: modelId,
			})
		).json();
		expect(removed.outcome).toBe("applied");
		expect(
			removed.conversation.cast.map((participant: { name: string }) =>
				participant.name,
			),
		).toEqual(["Writer", "Juno Ashfeld"]);

		// Historical display state: the captured author name stays visible
		// with the no-longer-in-Cast flag, and targeted Swipe is unavailable
		// with the derived reason.
		const greeting = removed.conversation.messages[0];
		expect(greeting?.author).toEqual({
			participantId: modelId,
			capturedName: "Maren Voss",
			inCast: false,
		});
		expect(greeting?.swipe).toEqual({
			eligible: false,
			reason: "historical-participant-unavailable",
		});
	});

	test("maps play-gated actions in incomplete Conversations to not-playable", async () => {
		const created = createConversationModule(database).create({
			name: "Incomplete Transport",
			messages: [
				{
					timestamp: "2026-08-20T10:00:00Z",
					variants: [
						{ content: "Preserved", timestamp: "2026-08-20T10:00:00Z", selected: true },
					],
				},
			],
		});
		const response = await command(created.id, created.revision, {
			type: "create-message",
			timestamp: "2026-08-20T11:00:00Z",
			variantContents: ["Composed"],
			authorParticipantId: 0,
		});
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.outcome).toBe("not-playable");
	});

	test("forks a Character through the workflow route with an applied outcome", async () => {
		const { id } = setupConversation();
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: definition({ name: "Maren Voss", openings: ["The lamp turns."] }),
		});

		const response = await addCharacter(id, {
			expectedConversationRevision: 0,
			characterId: source.id,
			expectedCharacterRevision: source.revision,
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.outcome).toBe("applied");
		expect(body.conversation.cast.at(-1)?.sourceCharacterId).toBe(source.id);
		expect(body.conversation.cast.at(-1)?.name).toBe("Maren Voss");
	});

	test("maps stale source and stale destination revisions to typed conflicts", async () => {
		const { id } = setupConversation();
		const library = createCharacterLibraryModule(database);
		const source = library.execute({
			type: "create",
			definition: definition(),
		});
		await library.execute({
			type: "rename",
			characterId: source.id,
			expectedRevision: source.revision,
			name: "Renamed",
		});

		const staleSource = await addCharacter(id, {
			expectedConversationRevision: 0,
			characterId: source.id,
			expectedCharacterRevision: source.revision,
		});
		expect(staleSource.status).toBe(409);
		const sourceBody = await staleSource.json();
		expect(sourceBody.outcome).toBe("conflict");
		expect(sourceBody.currentCharacter.name).toBe("Renamed");

		const staleDestination = await addCharacter(id, {
			expectedConversationRevision: 5,
			characterId: source.id,
			expectedCharacterRevision: 1,
		});
		expect(staleDestination.status).toBe(409);
		const destinationBody = await staleDestination.json();
		expect(destinationBody.outcome).toBe("conflict");
		expect(destinationBody.currentConversation.revision).toBe(0);
	});

	test("maps missing workflow references to typed not-found outcomes", async () => {
		const { id } = setupConversation();
		const missingCharacter = await addCharacter(id, {
			expectedConversationRevision: 0,
			characterId: 424242,
			expectedCharacterRevision: 0,
		});
		expect(missingCharacter.status).toBe(404);
		expect(await missingCharacter.json()).toEqual({ outcome: "not-found" });

		const missingConversation = await addCharacter(424242, {
			expectedConversationRevision: 0,
			characterId: 1,
			expectedCharacterRevision: 0,
		});
		expect(missingConversation.status).toBe(404);
	});
});

// Transport tests for the Save-as-Character workflow cover the request and
// response contract plus typed error mapping and revision propagation. The
// workflow behavior itself lives behind its own interface tests.
describe("Save Participant as Character transport adapter", () => {
	let database: Database;
	let app: ReturnType<typeof createConversationRoutes>;

	const saveParticipant = (
		conversationId: number,
		participantId: number,
		expectedConversationRevision: number,
	) =>
		app.handle(
			new Request(
				`http://localhost/api/conversations/${conversationId}/cast/participants/${participantId}/characters`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ expectedConversationRevision }),
				},
			),
		);

	const adHocDefinition = (name: string, openings: string[] = []) => ({
		name,
		prompt: {
			systemInstruction: "System text.",
			identity: "Identity text.",
			scenario: "",
			exampleDialogue: "",
			postHistoryInstruction: "",
		},
		openings,
	});

	const setupConversation = () => {
		const created = createNativeConversation(database, {
			name: "Transport Chat",
			humanSeat: {
				type: "adhoc",
				definition: adHocDefinition("Writer"),
			},
			modelSeat: {
				type: "adhoc",
				definition: adHocDefinition("Maren Voss", ["Hello"]),
			},
		});
		return {
			id: created.id,
			modelId: created.cast[1]?.id ?? 0,
			revision: created.revision,
		};
	};

	beforeEach(() => {
		database = openDatabase({ path: ":memory:" });
		app = createConversationRoutes(database);
	});

	afterEach(() => {
		database.close();
	});

	test("promotes a Participant with the applied outcome and the new Character payload", async () => {
		const { id, modelId } = setupConversation();

		const response = await saveParticipant(id, modelId, 0);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.outcome).toBe("applied");
		expect(body.character.name).toBe("Maren Voss");
		expect(body.character.revision).toBe(0);
		expect(body.character.openings).toEqual(["Hello"]);
		expect(body.character.prompt.identity).toBe("Identity text.");

		// The promoted Character is immediately visible through the library
		// list endpoint of the same transport surface.
		const listApp = createCharacterLibraryRoutes(database);
		const listed = await listApp.handle(new Request("http://localhost/api/characters"));
		const { characters } = await listed.json();
		expect(characters).toHaveLength(1);
		expect(characters[0]?.name).toBe("Maren Voss");
	});

	test("maps a stale Conversation revision to the typed conflict with the current snapshot", async () => {
		const { id, modelId } = setupConversation();
		// Advance the Conversation after the client's read revision (0).
		await app.handle(
			new Request(`http://localhost/api/conversations/${id}/commands`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					expectedRevision: 0,
					action: {
						type: "add-participant",
						definition: adHocDefinition("Added Later"),
					},
				}),
			}),
		);

		const stale = await saveParticipant(id, modelId, 0);
		expect(stale.status).toBe(409);
		const body = await stale.json();
		expect(body.outcome).toBe("conflict");
		expect(body.expectedRevision).toBe(0);
		expect(body.actualRevision).toBe(1);
		expect(body.currentConversation.revision).toBe(1);
		expect(body.currentConversation.cast).toHaveLength(3);

		// The stale save created no Character.
		const listApp = createCharacterLibraryRoutes(database);
		const listed = await listApp.handle(new Request("http://localhost/api/characters"));
		expect((await listed.json()).characters).toHaveLength(0);
	});

	test("maps missing Conversation and missing Participant to typed not-found outcomes", async () => {
		const { id, modelId } = setupConversation();

		const missingConversation = await saveParticipant(424242, modelId, 0);
		expect(missingConversation.status).toBe(404);
		expect(await missingConversation.json()).toEqual({ outcome: "not-found" });

		const missingParticipant = await saveParticipant(id, 987654, 0);
		expect(missingParticipant.status).toBe(404);
		expect(await missingParticipant.json()).toEqual({ outcome: "not-found" });
	});
});
