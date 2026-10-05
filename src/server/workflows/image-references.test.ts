import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { createCharacterLibraryModule } from "../character-library";
import { createConversationModule, deleteConversation, InvalidConversationCommandError } from "../conversation";
import { createConversationRoutes } from "../contract/conversation";
import { createConnectionSettingsModule } from "../connection-settings";
import { base64, pngFixture } from "../image/image-fixtures";
import { ingestUploads, type ImagePool } from "../image";
import { Value } from "@sinclair/typebox/value";
import { activeGenerationDetails, generationAccepted, generationPreview, type GenerationBody, type GenerationPreviewBody } from "../../shared/contract/conversation-schema";
import { formatImageReference } from "../../shared/image-reference";
import { acceptConversationTailGeneration } from "../conversation/commands/accept-generation";
import { resolveConversationGeneration } from "../conversation/commands/active-generation";
import { createNativeConversation } from ".";
import { captureSendGenerationAsync, capturedAcceptanceFields } from "./generate-capture";

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
const writer = { name: "Writer", prompt, openings: [] };
const timestamp = "2026-10-04T00:00:00.000Z";

const picture = async (width: number): Promise<{ hash: string; pool: ImagePool; token: string }> => {
	const pool = await ingestUploads([base64(pngFixture({ width }))]);
	const [hash] = [...pool.keys()];
	if (hash === undefined) throw new Error("fixture produced no image");
	return { hash, pool, token: formatImageReference("map", hash) };
};

describe("Image Reference lifetime", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => { database.close(); });

	const stored = () => database.query<{ hash: string }, []>("SELECT hash FROM image").all().map((row) => row.hash);
	const conversations = () => createConversationModule(database);
	const library = () => createCharacterLibraryModule(database);

	const chat = () => conversations().create({
		name: "Chat",
		participants: [{ definition: writer }, { definition: { ...writer, name: "Maren" } }],
		control: { human: 0, model: 1 },
	});

	const writeMessage = (target: ReturnType<typeof chat>, variantContents: string[], images?: ImagePool) =>
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "create-message", timestamp, variantContents, authorParticipantId: target.cast[0]!.id },
			images,
		});

	const lastMessage = (target: ReturnType<typeof chat>) => {
		const message = conversations().getSnapshot(target.id)?.messages.at(-1);
		if (message === undefined) throw new Error("no message");
		return message;
	};

	test("a Variant's Image exists once its command commits and goes with the last edit that removes it", async () => {
		const target = chat();
		const art = await picture(4);
		writeMessage(target, [`Look: ${art.token}`], art.pool);
		expect(stored()).toEqual([art.hash]);

		const message = lastMessage(target);
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "edit-variant", messageId: message.id, variantId: message.variants[0]!.id, content: "Nothing now." },
		});
		expect(stored()).toEqual([]);
	});

	test("a pasted token needs no bytes and keeps the Image alive after its original goes", async () => {
		const target = chat();
		const art = await picture(4);
		writeMessage(target, [art.token], art.pool);
		const original = lastMessage(target);
		writeMessage(target, [`Again ${art.token}`]);
		expect(stored()).toEqual([art.hash]);

		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "delete-message", messageId: original.id },
		});
		expect(stored()).toEqual([art.hash]);

		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "delete-message", messageId: lastMessage(target).id },
		});
		expect(stored()).toEqual([]);
	});

	test("a Reference to an Image that is nowhere stores the text as written and creates nothing", () => {
		const target = chat();
		const text = formatImageReference("ghost", "c".repeat(64));
		writeMessage(target, [text]);
		expect(lastMessage(target).variants[0]?.content).toBe(text);
		expect(stored()).toEqual([]);
	});

	test("a rejected command leaves neither the Image nor a reference", async () => {
		const target = chat();
		const art = await picture(4);
		expect(() => conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "create-message", timestamp, variantContents: [art.token], authorParticipantId: 9999 },
			images: art.pool,
		})).toThrow(InvalidConversationCommandError);
		expect(stored()).toEqual([]);
		expect(database.query("SELECT id FROM image_reference").all()).toEqual([]);
	});

	test("a new Variant's Image is held by that Variant alone", async () => {
		const target = chat();
		writeMessage(target, ["plain"]);
		const message = lastMessage(target);
		const art = await picture(4);
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "create-variant", messageId: message.id, content: art.token },
			images: art.pool,
		});
		expect(stored()).toEqual([art.hash]);
		const added = lastMessage(target).variants.find((variant) => variant.content === art.token);
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "delete-variant", messageId: message.id, variantId: added!.id },
		});
		expect(stored()).toEqual([]);
	});

	test("Definition Prompt channels and Openings hold Images, and a seeded Participant keeps its own copy", async () => {
		const [art, opening] = [await picture(4), await picture(5)];
		const character = library().execute({
			type: "create",
			definition: { name: "Maren", prompt: { ...prompt, identity: `Looks like ${art.token}` }, openings: [`Hello ${opening.token}`] },
		}, new Map([...art.pool, ...opening.pool]));
		expect(stored().sort()).toEqual([art.hash, opening.hash].sort());

		const seeded = createNativeConversation(database, {
			name: "Chat",
			humanSeat: { type: "adhoc", definition: writer },
			modelSeat: { type: "character", characterId: character.id, expectedRevision: character.revision },
		});
		library().execute({ type: "delete", characterId: character.id, expectedRevision: character.revision });
		expect(stored().sort()).toEqual([art.hash, opening.hash].sort());

		deleteConversation(database, seeded.id);
		expect(stored()).toEqual([]);
	});

	test("editing a Participant's Definition re-syncs its Images", async () => {
		const target = chat();
		const art = await picture(4);
		const maren = target.cast[1]!;
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "update-participant-definition", participantId: maren.id, definition: { name: "Maren", prompt: { ...prompt, scenario: art.token }, openings: [] } },
			images: art.pool,
		});
		expect(stored()).toEqual([art.hash]);
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "update-participant-definition", participantId: maren.id, definition: { name: "Maren", prompt, openings: [] } },
		});
		expect(stored()).toEqual([]);
	});

	test("an Image held only by a non-selected Variant's Macro State survives until that Variant goes", async () => {
		const target = chat();
		writeMessage(target, ["first", "second"]);
		const message = lastMessage(target);
		const [firstVariant, secondVariant] = message.variants;
		const art = await picture(4);
		const presetId = conversations().readMacroVariables(target.id)?.promptPresetId ?? 1;

		conversations().editMacroVariables({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			promptPresetId: presetId,
			position: message.position,
			operation: "set",
			name: "outfit",
			value: art.token,
			images: art.pool,
		});
		expect(stored()).toEqual([art.hash]);

		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "select-variant", messageId: message.id, variantId: secondVariant!.id },
		});
		expect(stored()).toEqual([art.hash]);

		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "delete-variant", messageId: message.id, variantId: firstVariant!.id },
		});
		expect(stored()).toEqual([]);
	});

	test("an initial Macro Variable holds its Image until the variable is deleted", async () => {
		const target = chat();
		const art = await picture(4);
		const presetId = conversations().readMacroVariables(target.id)?.promptPresetId ?? 1;
		const edit = (body: { operation: "set"; value: string; images?: ImagePool } | { operation: "delete" }) => conversations().editMacroVariables({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			promptPresetId: presetId,
			position: 0,
			name: "outfit",
			...body,
		});
		edit({ operation: "set", value: art.token, images: art.pool });
		expect(stored()).toEqual([art.hash]);
		edit({ operation: "set", value: "plain" });
		expect(stored()).toEqual([]);
	});

	test("Macro State written by setvar during a Generation holds its Image after the Definition lets go", async () => {
		const art = await picture(4);
		const target = conversations().create({
			name: "Chat",
			images: art.pool,
			participants: [
				{ definition: writer },
				{ definition: { name: "Maren", prompt: { ...prompt, systemInstruction: `{{setvar::outfit::${art.token}}}` }, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const captured = await captureSendGenerationAsync({ database, conversationId: target.id, content: "Hello" });
		const accepted = acceptConversationTailGeneration(database, {
			...capturedAcceptanceFields(captured, { conversationId: target.id, timestamp }),
			expectedRevision: target.revision,
			humanContent: "Hello",
		});
		resolveConversationGeneration(database, {
			conversationId: target.id,
			generationId: accepted.generationId,
			timestamp,
			content: "Done",
		});
		expect(stored()).toEqual([art.hash]);

		const maren = conversations().getSummary(target.id)!.cast[1]!;
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "update-participant-definition", participantId: maren.id, definition: { name: "Maren", prompt, openings: [] } },
		});
		expect(stored()).toEqual([art.hash]);

		deleteConversation(database, target.id);
		expect(stored()).toEqual([]);
	});

	test("Send carries inline bytes and keeps the Image only once accepted", async () => {
		const target = chat();
		createConnectionSettingsModule(database, { masterKey: new Uint8Array(32).fill(9) }).createProfile({
			expectedRevision: 0,
			profile: {
				displayName: "Profile",
				apiFormat: "chat-completions",
				requestUrl: "http://127.0.0.1:43127/v1/",
				modelsUrl: "",
				modelBackend: "automatic",
				adapter: "deepseek",
				outputTokenRepresentation: "automatic",
				timeoutMs: 120_000,
				pinnedModels: [],
			},
			credential: "secret",
		});
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(9),
			fetch: async () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
		});
		const art = await picture(4);
		const send = (content: string, images: string[]) => app.handle(new Request(
			`http://localhost/api/conversations/${target.id}/generations`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ expectedRevision: conversations().getRevision(target.id), content, images }),
			},
		));

		const rejected = await send("  ", [base64(pngFixture({ width: 4 }))]);
		expect(rejected.status).toBe(422);
		expect(stored()).toEqual([]);

		const unsupported = await send(art.token, [base64(Buffer.from("not an image"))]);
		expect(unsupported.status).toBe(422);
		expect(stored()).toEqual([]);

		const accepted = await send(art.token, [base64(pngFixture({ width: 4 }))]);
		expect(accepted.status).toBe(200);
		expect(stored()).toEqual([art.hash]);
	});

	test("an Active Generation holds the Images its plan references until it settles", async () => {
		const target = chat();
		const art = await picture(4);
		const captured = await captureSendGenerationAsync({ database, conversationId: target.id, content: "Hello" });
		const fields = capturedAcceptanceFields(captured, { conversationId: target.id, timestamp });
		const accepted = acceptConversationTailGeneration(database, {
			...fields,
			promptPlan: { ...fields.promptPlan, blocks: [{ kind: "instruction", role: "system", content: `Show ${art.token}` }] },
			images: art.pool,
			expectedRevision: target.revision,
			humanContent: "Hello",
		});
		expect(stored()).toEqual([art.hash]);

		resolveConversationGeneration(database, { conversationId: target.id, generationId: accepted.generationId, timestamp, content: "Done" });
		expect(stored()).toEqual([]);
	});

	test("an inspected plan edited to add an Image is resolved over the edit and shown in Generation Details", async () => {
		const target = chat();
		createConnectionSettingsModule(database, { masterKey: new Uint8Array(32).fill(9) }).createProfile({
			expectedRevision: 0,
			profile: {
				displayName: "Profile",
				apiFormat: "chat-completions",
				requestUrl: "http://127.0.0.1:43127/v1/",
				modelsUrl: "",
				modelBackend: "automatic",
				adapter: "deepseek",
				outputTokenRepresentation: "automatic",
				timeoutMs: 120_000,
				pinnedModels: [],
			},
			credential: "secret",
		});
		const app = createConversationRoutes(database, {
			masterKey: new Uint8Array(32).fill(9),
			fetch: async () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
		});
		const post = (path: string, body: GenerationBody | GenerationPreviewBody) => app.handle(new Request(`http://localhost/api/conversations/${target.id}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}));
		const art = await picture(4);
		const ghost = formatImageReference("ghost", "f".repeat(64));

		const preview = Value.Parse(generationPreview, await (await post("/generations/preview", { kind: "send", content: "Hello" })).json());
		expect(preview.promptPlan.images).toEqual([]);
		const last = preview.promptPlan.blocks.length - 1;
		const edited = {
			...preview.promptPlan,
			blocks: preview.promptPlan.blocks.map((block, index) => index === last ? { ...block, content: `${block.content} ${art.token} ${ghost}` } : block),
		};
		const sent = await post("/generations", {
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			content: "Hello",
			previewId: preview.previewId,
			promptPlan: edited,
			images: [base64(pngFixture({ width: 4 }))],
		});
		expect(sent.status).toBe(200);
		const { generationId } = Value.Parse(generationAccepted, await sent.json());

		const details = Value.Parse(activeGenerationDetails, await (await app.handle(new Request(`http://localhost/api/conversations/${target.id}/generations/${generationId}/inspection`))).json());
		expect(details.promptPlan.images.map(({ hash, name, disposition }) => ({ hash, name, disposition }))).toEqual([
			{ hash: art.hash, name: "map", disposition: "send" },
			{ hash: "f".repeat(64), name: "ghost", disposition: "missing" },
		]);
		expect(details.promptPlan.images[0]?.tokens).toBeGreaterThan(0);
	});
});
