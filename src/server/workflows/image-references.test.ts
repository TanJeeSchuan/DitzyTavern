import { openObservedDatabase } from "../conversation/test-fixtures";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createCharacterLibraryModule } from "../character-library";
import { createConversationModule, deleteConversation, InvalidConversationCommandError } from "../conversation";
import { createConversationRoutes } from "../contract/conversation";
import { createConnectionSettingsModule } from "../connection-settings";
import { pngFixture } from "../image/image-fixtures";
import { uploadImage, sweepOrphanedImages } from "../image";
import { Value } from "@sinclair/typebox/value";
import { activeGenerationDetails, generationAccepted, generationPreview, type GenerationBody, type GenerationPreviewBody } from "../../shared/contract/conversation-schema";
import { formatImageReference } from "../../shared/image-reference";
import type { MacroValue } from "../../shared/contract/macro-variable-write";
import { acceptConversationTailGeneration } from "../conversation/commands/accept-generation";
import { checkpointConversationGeneration, resolveConversationGeneration } from "../conversation/commands/active-generation";
import { removeRetainedGenerationInspection } from "../conversation/generation-retention";
import { createNativeConversation } from ".";
import { captureGeneration, capturedAcceptanceFields } from "./generate-capture";

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
const writer = { name: "Writer", prompt, openings: [] };
const timestamp = "2026-10-04T00:00:00.000Z";

describe("Image Reference lifetime", () => {
	let database: Database;

	beforeEach(() => {
		database = openObservedDatabase();
	});
	afterEach(() => { database.close(); });

	const picture = async (width: number) => {
		const { hash } = await uploadImage(database, pngFixture({ width }));
		return { hash, token: formatImageReference("map", hash) };
	};
	const referenced = () => { sweepOrphanedImages(database); return database.query<{ hash: string }, []>("SELECT hash FROM image WHERE orphaned_at IS NULL").all().map((row) => row.hash); };
	const orphanedAt = (hash: string) => { sweepOrphanedImages(database); return database.query<{ orphaned_at: number | null }, [string]>("SELECT orphaned_at FROM image WHERE hash = ?").get(hash)?.orphaned_at; };
	const stored = () => database.query<{ hash: string }, []>("SELECT hash FROM image").all().map((row) => row.hash);
	const conversations = () => createConversationModule(database);
	const library = () => createCharacterLibraryModule(database);

	const chat = () => conversations().create({
		name: "Chat",
		participants: [{ definition: writer }, { definition: { ...writer, name: "Maren" } }],
		control: { human: 0, model: 1 },
	});

	const writeMessage = (target: ReturnType<typeof chat>, variantContents: string[]) =>
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "create-message", timestamp, variantContents, authorParticipantId: target.cast[0]!.id },
		});

	const lastMessage = (target: ReturnType<typeof chat>) => {
		const message = conversations().getSnapshot(target.id)?.messages.at(-1);
		if (message === undefined) throw new Error("no message");
		return message;
	};

	test("a Variant's Image exists once its command commits and becomes orphaned after its last edit", async () => {
		const target = chat();
		const art = await picture(4);
		writeMessage(target, [`Look: ${art.token}`]);
		expect(referenced()).toEqual([art.hash]);

		const message = lastMessage(target);
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "edit-variant", messageId: message.id, variantId: message.variants[0]!.id, content: "Nothing now." },
		});
		expect(referenced()).toEqual([]);
		expect(stored()).toEqual([art.hash]);
		expect(orphanedAt(art.hash)).toBeNumber();
		conversations().execute({
			conversationId: target.id, expectedRevision: conversations().getRevision(target.id)!,
			action: { type: "edit-variant", messageId: message.id, variantId: message.variants[0]!.id, content: art.token },
		});
		expect(orphanedAt(art.hash)).toBeNull();
	});

	test("removing and restoring the last Reference restarts its grace period at the sweep", async () => {
		const target = chat();
		const art = await picture(4);
		writeMessage(target, [art.token]);
		const message = lastMessage(target);
		const edit = (content: string) => conversations().execute({
			conversationId: target.id, expectedRevision: conversations().getRevision(target.id)!,
			action: { type: "edit-variant", messageId: message.id, variantId: message.variants[0]!.id, content },
		});
		const now = Date.now();
		const day = 24 * 60 * 60 * 1000;
		sweepOrphanedImages(database, now);
		edit("Gone");
		sweepOrphanedImages(database, now + day);
		expect(database.query("SELECT orphaned_at FROM image WHERE hash = ?").get(art.hash)).toEqual({ orphaned_at: now + day });
		edit(art.token);
		sweepOrphanedImages(database, now + 3 * day);
		expect(database.query("SELECT orphaned_at FROM image WHERE hash = ?").get(art.hash)).toEqual({ orphaned_at: null });
		edit("Gone again");
		sweepOrphanedImages(database, now + 4 * day);
		sweepOrphanedImages(database, now + 5 * day);
		expect(stored()).toEqual([art.hash]);
		sweepOrphanedImages(database, now + 5 * day + 1);
		expect(stored()).toEqual([]);
	});

	test("a Reference saved while its Image is missing protects the re-upload past its grace period", async () => {
		const target = chat();
		const art = await picture(4);
		const day = 24 * 60 * 60 * 1000;
		sweepOrphanedImages(database, Date.now() + day + 1);
		expect(stored()).toEqual([]);
		writeMessage(target, [art.token]);
		expect(lastMessage(target).variants[0]?.content).toBe(art.token);
		expect(await uploadImage(database, pngFixture({ width: 4 }))).toEqual({ hash: art.hash });
		sweepOrphanedImages(database, Date.now() + 2 * day);
		expect(stored()).toEqual([art.hash]);
		expect(orphanedAt(art.hash)).toBeNull();
	});

	for (const owner of ["Character", "Participant"] as const) {
		test(`${owner} Portrait, every Prompt channel, and Opening survive overdue uploads and release after deletion`, async () => {
			const pictures = await Promise.all([11, 12, 13, 14, 15, 16, 17].map(picture));
			const [portrait, system, identity, scenario, dialogue, postHistory, opening] = pictures;
			const definition = {
				name: "Maren",
				portrait: { hash: portrait!.hash, focalX: 0.5, focalY: 0.5 },
				prompt: { systemInstruction: system!.token, identity: identity!.token, scenario: scenario!.token, exampleDialogue: dialogue!.token, postHistoryInstruction: postHistory!.token },
				openings: [opening!.token],
			};
			const character = owner === "Character" ? library().execute({ type: "create", definition }) : undefined;
			const target = owner === "Participant" ? conversations().create({ authorNote: "", name: "Chat", participants: [{ definition: writer }, { definition }], control: { human: 0, model: 1 } }) : undefined;
			const now = Date.now() + 2 * 24 * 60 * 60 * 1000;
			sweepOrphanedImages(database, now);
			expect(stored().sort()).toEqual(pictures.map(({ hash }) => hash).sort());
			if (character !== undefined) library().execute({ type: "delete", characterId: character.id, expectedRevision: character.revision });
			if (target !== undefined) deleteConversation(database, target.id);
			sweepOrphanedImages(database, now);
			expect(stored()).toHaveLength(7);
			sweepOrphanedImages(database, now + 24 * 60 * 60 * 1000 + 1);
			expect(stored()).toEqual([]);
		});
	}

	test("a pasted token needs no bytes and keeps the Image alive after its original goes", async () => {
		const target = chat();
		const art = await picture(4);
		writeMessage(target, [art.token]);
		const original = lastMessage(target);
		writeMessage(target, [`Again ${art.token}`]);
		expect(referenced()).toEqual([art.hash]);

		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "delete-message", messageId: original.id },
		});
		expect(referenced()).toEqual([art.hash]);

		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "delete-message", messageId: lastMessage(target).id },
		});
		expect(referenced()).toEqual([]);
	});

	test("a Reference to an Image that is nowhere stores the text as written and creates nothing", () => {
		const target = chat();
		const text = formatImageReference("ghost", "c".repeat(64));
		writeMessage(target, [text]);
		expect(lastMessage(target).variants[0]?.content).toBe(text);
		expect(referenced()).toEqual([]);
	});

	test("a rejected command leaves its upload orphaned without a reference", async () => {
		const target = chat();
		const art = await picture(4);
		expect(() => conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "create-message", timestamp, variantContents: [art.token], authorParticipantId: 9999 },
		})).toThrow(InvalidConversationCommandError);
		expect(referenced()).toEqual([]);
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
		});
		expect(referenced()).toEqual([art.hash]);
		const added = lastMessage(target).variants.find((variant) => variant.content === art.token);
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "delete-variant", messageId: message.id, variantId: added!.id },
		});
		expect(referenced()).toEqual([]);
	});

	test("Definition Prompt channels and Openings hold Images, and a seeded Participant keeps its own copy", async () => {
		const [art, opening] = [await picture(4), await picture(5)];
		const character = library().execute({
			type: "create",
			definition: { name: "Maren", prompt: { ...prompt, identity: `Looks like ${art.token}` }, openings: [`Hello ${opening.token}`] },
		});
		expect(referenced().sort()).toEqual([art.hash, opening.hash].sort());

		const seeded = createNativeConversation(database, {
			name: "Chat",
			humanSeat: { type: "adhoc", definition: writer },
			modelSeat: { type: "character", characterId: character.id, expectedRevision: character.revision },
		});
		library().execute({ type: "delete", characterId: character.id, expectedRevision: character.revision });
		expect(referenced().sort()).toEqual([art.hash, opening.hash].sort());

		deleteConversation(database, seeded.id);
		expect(referenced()).toEqual([]);
	});

	test("editing a Participant's Definition changes the Images held at startup", async () => {
		const target = chat();
		const art = await picture(4);
		const maren = target.cast[1]!;
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "update-participant-definition", participantId: maren.id, definition: { name: "Maren", prompt: { ...prompt, scenario: art.token }, openings: [] } },
		});
		expect(referenced()).toEqual([art.hash]);
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "update-participant-definition", participantId: maren.id, definition: { name: "Maren", prompt, openings: [] } },
		});
		expect(referenced()).toEqual([]);
	});

	for (const owner of ["Character", "Participant"] as const) {
		for (const from of ["portrait", "prompt", "opening"] as const) {
			for (const to of ["portrait", "prompt", "opening"] as const) {
				if (from === to) continue;
				test(`${owner} Definition moves its only Image from ${from} to ${to} without uploading it again`, async () => {
					const art = await picture(4);
					const definition = (kind: typeof from) => ({
						name: "Maren",
						prompt: { ...prompt, identity: kind === "prompt" ? art.token : "" },
						openings: kind === "opening" ? [art.token] : [],
						portrait: kind === "portrait" ? { hash: art.hash, focalX: 0.5, focalY: 0.5 } : undefined,
					});
					if (owner === "Character") {
						const character = library().execute({ type: "create", definition: definition(from) });
						library().execute({ type: "update-definition", characterId: character.id, expectedRevision: character.revision, definition: definition(to) });
					} else {
						const target = chat();
						conversations().execute({ conversationId: target.id, expectedRevision: target.revision, action: { type: "update-participant-definition", participantId: target.cast[1]!.id, definition: definition(from) } });
						conversations().execute({ conversationId: target.id, expectedRevision: conversations().getRevision(target.id)!, action: { type: "update-participant-definition", participantId: target.cast[1]!.id, definition: definition(to) } });
					}
					expect(referenced()).toEqual([art.hash]);
				});
			}
		}
	}

	test("an Image held only by a non-selected Variant's Macro State survives until that Variant goes", async () => {
		const target = chat();
		writeMessage(target, ["first", "second"]);
		const message = lastMessage(target);
		const [firstVariant, secondVariant] = message.variants;
		const art = await picture(4);
		const presetId = conversations().readMacroVariables(target.id)?.promptPresetId;
		if (presetId === undefined || presetId === null) throw new Error("Prompt Preset missing.");

		conversations().editMacroVariables({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			promptPresetId: presetId,
			position: message.position,
			operation: "set",
			name: "outfit",
			value: art.token,
		});
		expect(referenced()).toEqual([art.hash]);

		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "select-variant", messageId: message.id, variantId: secondVariant!.id },
		});
		sweepOrphanedImages(database, Date.now() + 48 * 60 * 60 * 1000);
		expect(stored()).toEqual([art.hash]);
		expect(referenced()).toEqual([art.hash]);

		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "delete-variant", messageId: message.id, variantId: firstVariant!.id },
		});
		expect(referenced()).toEqual([]);
	});

	test("an initial Macro Variable holds its Image until the variable is deleted", async () => {
		const target = chat();
		const art = await picture(4);
		const presetId = conversations().readMacroVariables(target.id)?.promptPresetId;
		if (presetId === undefined || presetId === null) throw new Error("Prompt Preset missing.");
		const edit = (body: { operation: "set"; value: string } | { operation: "delete" }) => conversations().editMacroVariables({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			promptPresetId: presetId,
			position: 0,
			name: "outfit",
			...body,
		});
		edit({ operation: "set", value: art.token });
		expect(referenced()).toEqual([art.hash]);
		edit({ operation: "set", value: "plain" });
		expect(referenced()).toEqual([]);
	});

	test("an initial Macro Variable keeps its Image when its replacement label needs JSON escaping", async () => {
		const target = chat();
		const art = await picture(4);
		const presetId = conversations().readMacroVariables(target.id)?.promptPresetId;
		if (presetId === undefined || presetId === null) throw new Error("Prompt Preset missing.");
		const set = (value: MacroValue) => conversations().editMacroVariables({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			promptPresetId: presetId,
			position: 0,
			operation: "set",
			name: "outfit",
			value,
		});
		set(formatImageReference("a b", art.hash));
		expect(referenced()).toEqual([art.hash]);
		set(`![a\tb](image:${art.hash})`);
		expect(referenced()).toEqual([art.hash]);
	});

	test("a nested Macro Value holds its Image and releases it with the last reference", async () => {
		const target = chat();
		const art = await picture(4);
		const presetId = conversations().readMacroVariables(target.id)?.promptPresetId;
		if (presetId === undefined || presetId === null) throw new Error("Prompt Preset missing.");
		const set = (value: MacroValue) => conversations().editMacroVariables({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			promptPresetId: presetId,
			position: 0,
			operation: "set",
			name: "outfit",
			value,
		});
		set(["plain", [art.token]]);
		expect(referenced()).toEqual([art.hash]);
		set(["plain", ["gone"]]);
		expect(referenced()).toEqual([]);
	});

	test("Macro State written by setvar during a Generation holds its Image after the Definition lets go", async () => {
		const art = await picture(4);
		const target = conversations().create({
			name: "Chat",
			participants: [
				{ definition: writer },
				{ definition: { name: "Maren", prompt: { ...prompt, systemInstruction: `{{setvar::outfit::${art.token}}}` }, openings: [] } },
			],
			control: { human: 0, model: 1 },
		});
		const captured = await captureGeneration(database, { kind: "send", content: "Hello" }, {connection: null, conversationId: target.id });
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
		expect(referenced()).toEqual([art.hash]);

		const maren = conversations().getSummary(target.id)!.cast[1]!;
		conversations().execute({
			conversationId: target.id,
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			action: { type: "update-participant-definition", participantId: maren.id, definition: { name: "Maren", prompt, openings: [] } },
		});
		expect(referenced()).toEqual([art.hash]);

		deleteConversation(database, target.id);
		expect(referenced()).toEqual([]);
	});

	test("a Generation holds the Images its plan references until its retained inspection is removed", async () => {
		const target = chat();
		const art = await picture(4);
		const captured = await captureGeneration(database, { kind: "send", content: "Hello" }, {connection: null, conversationId: target.id });
		const fields = capturedAcceptanceFields(captured, { conversationId: target.id, timestamp });
		const accepted = acceptConversationTailGeneration(database, {
			...fields,
			promptPlan: { ...fields.promptPlan, blocks: [{ kind: "instruction", role: "system", content: `Show ${art.token}` }] },
			expectedRevision: target.revision,
			humanContent: "Hello",
		});
		expect(referenced()).toEqual([art.hash]);

		resolveConversationGeneration(database, { conversationId: target.id, generationId: accepted.generationId, timestamp, content: "Done" });
		expect(referenced()).toEqual([art.hash]);

		removeRetainedGenerationInspection(database, accepted.generationId);
		expect(referenced()).toEqual([]);
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
			kind: "send",
			expectedRevision: conversations().getRevision(target.id) ?? 0,
			content: "Hello",
			previewId: preview.previewId,
			promptPlan: edited,
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

	test("startup sweep expires only Images orphaned longer than 24 hours", async () => {
		const now = Date.now();
		const [old, boundary, recent, held] = await Promise.all([picture(1), picture(2), picture(3), picture(4)]);
		const target = chat();
		writeMessage(target, [held.token]);
		const age = (hash: string, at: number) => database.query("UPDATE image SET orphaned_at = ? WHERE hash = ?").run(at, hash);
		age(old.hash, now - 24 * 60 * 60 * 1000 - 1);
		age(boundary.hash, now - 24 * 60 * 60 * 1000);
		age(recent.hash, now - 1000);
		sweepOrphanedImages(database, now);
		expect(stored().sort()).toEqual([boundary.hash, recent.hash, held.hash].sort());
		expect(orphanedAt(held.hash)).toBeNull();
	});

	test("a checkpointed Variant adopts References and releases them when checkpoint text changes", async () => {
		const target = chat();
		const art = await picture(4);
		const captured = await captureGeneration(database, { kind: "send", content: "Hello" }, {connection: null, conversationId: target.id });
		const accepted = acceptConversationTailGeneration(database, {
			...capturedAcceptanceFields(captured, { conversationId: target.id, timestamp }),
			expectedRevision: target.revision, humanContent: "Hello",
		});
		checkpointConversationGeneration(database, { conversationId: target.id, generationId: accepted.generationId, content: art.token, latestEventId: 1 });
		expect(orphanedAt(art.hash)).toBeNull();
		expect(lastMessage(target).variants[0]?.content).toBe(art.token);
		checkpointConversationGeneration(database, { conversationId: target.id, generationId: accepted.generationId, content: "Plain", latestEventId: 2 });
		expect(orphanedAt(art.hash)).toBeNumber();
		expect(stored()).toEqual([art.hash]);
	});

	for (const owner of ["Character", "Participant"] as const) {
		test(`${owner} partial Definition writes keep the untouched Portrait and Openings`, async () => {
			const art = await picture(4);
			const definition = { ...writer, portrait: { hash: art.hash, focalX: 0.5, focalY: 0.5 }, prompt: { ...prompt, identity: art.token }, openings: [art.token] };
			if (owner === "Character") {
				const character = library().execute({ type: "create", definition });
				const updated = library().execute({ type: "replace-prompt", characterId: character.id, expectedRevision: character.revision, prompt });
				library().execute({ type: "replace-openings", characterId: character.id, expectedRevision: updated.revision, openings: [] });
			} else {
				const target = chat();
				const participantId = target.cast[1]!.id;
				const execute = (action: Parameters<ReturnType<typeof conversations>["execute"]>[0]["action"]) => conversations().execute({ conversationId: target.id, expectedRevision: conversations().getRevision(target.id)!, action });
				execute({ type: "update-participant-definition", participantId, definition });
				execute({ type: "replace-participant-prompt", participantId, prompt });
				execute({ type: "replace-participant-openings", participantId, openings: [] });
			}
			expect(orphanedAt(art.hash)).toBeNull();
		});
	}
});
