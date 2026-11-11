import { createGenerationPreviewAsync } from "../workflows/generation-preview";
import { expect, test } from "bun:test";
import { createConversationWithHistory, openObservedDatabase } from "../test-fixtures/conversation";
import { executeConversationCommand, readConversationSummary, observeConversationWrites } from "../conversation";
import { createConnectionSettingsModule } from "../connection-settings";
import { initializeConnectionSecretKey } from "../connection-secrets";
import { blankConnectionProfileDraft } from "../../shared/contract/connection-settings";
import { applyImageModelSettings } from "./image-model-settings";
import { createPaintingModule } from ".";
import { pngFixture } from "../image/image-fixtures";
import { imageLoader } from "../image";
import { processStateFor } from "../application/process-state";
import { subscribeDatabaseChanges, watchDatabaseChanges } from "../database/changes";

const setup = () => {
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.alloc(32, 1).toString("base64") } });
	const database = openObservedDatabase();
	const connections = createConnectionSettingsModule(database);
	connections.createProfile({ expectedRevision: 0, profile: { ...blankConnectionProfileDraft, displayName: "Painter", apiFormat: "images", adapter: "openrouter", requestUrl: "https://example.com/images" } });
	applyImageModelSettings(database, { type: "apply", expectedRevision: 0, profileId: connections.get().profiles[0]!.id, model: "painter" });
	const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
	const chat = createConversationWithHistory(database, { name: "Painting", participants: [
		{ definition: { name: "Writer", prompt, openings: [] } },
		{ definition: { name: "Maren", prompt, openings: ["First scene", "Other scene"] } },
	], control: { human: 0, model: 1 } });
	const stop = watchDatabaseChanges(database);
	return { database, chat, [Symbol.dispose]: () => { stop(); processStateFor(database).dispose(); database.close(); } };
};

test("an Illustration lands on its original Variant after a swipe without a Conversation write, through Image ingest", async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const reply = Promise.withResolvers<Response>();
	const module = createPaintingModule(database, { fetch: () => reply.promise });
	const message = chat.messages[0]!;
	const variantId = message.variants[0]!.id;
	module.command(chat.id, { type: "paint", variantId, brief: "Private painted scene", aspectRatio: "3:4" });
	expect(module.read(chat.id).paintings).toMatchObject([{ kind: "painting", variantId }]);
	expect(database.query("SELECT * FROM message_variant_data WHERE namespace = 'painting'").all()).toHaveLength(0);
	const targets = [{ kind: "send", content: "Continue the scene" }, { kind: "continuation" }, { kind: "sibling", messageId: message.id }] as const;
	const plans = async () => Promise.all(targets.map(async (target) => (await createGenerationPreviewAsync(database, { conversationId: chat.id, connection: null, ...target })).capture.plan.promptPlan));
	const provisionalPlans = await plans();
	expect(JSON.stringify(provisionalPlans)).not.toContain("Private painted scene");
	const selected = executeConversationCommand(database, { conversationId: chat.id, expectedRevision: chat.revision, action: { type: "select-variant", messageId: message.id, variantId: message.variants[1]!.id } });
	let writes = 0;
	observeConversationWrites(database, () => { writes++; return () => {}; });
	const finished = Promise.withResolvers<void>();
	const unsubscribe = subscribeDatabaseChanges(database, () => { if (module.read(chat.id).paintings.some((entry) => entry.kind === "illustration")) finished.resolve(); }, () => {});
	reply.resolve(Response.json({ data: [{ b64_json: pngFixture({ card: "private metadata" }).toString("base64") }] }));
	await finished.promise;
	unsubscribe();
	const painting = module.read(chat.id).paintings[0]!;
	expect(painting).toMatchObject({ kind: "illustration", variantId, brief: "Private painted scene", aspectRatio: "3:4" });
	expect(readConversationSummary(database, chat.id)?.revision).toBe(selected.revision);
	expect(writes).toBe(0);
	if (painting.kind !== "illustration") throw new Error("Illustration missing");
	const image = imageLoader(database)(painting.image.slice(6));
	expect(image?.mediaType).toBe("image/png");
	expect(image?.bytes.includes(Buffer.from("private metadata"))).toBe(false);
	expect(JSON.stringify(await plans())).not.toContain("Private painted scene");
	expect(JSON.stringify(await plans())).not.toContain(painting.image.slice(6));
});


test("provider failures persist until retry or dismissal; restarting drops provisional paintings", async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	let calls = 0;
	const module = createPaintingModule(database, { fetch: async () => {
		calls++;
		return calls === 1 ? Response.json({ error: { message: "The provider refused this Brief." } }, { status: 400 }) : Response.json({ data: [{ b64_json: pngFixture().toString("base64") }] });
	} });
	const settled = () => {
		const result = Promise.withResolvers<void>();
		const unsubscribe = subscribeDatabaseChanges(database, () => { if (module.read(chat.id).paintings.every((entry) => entry.kind !== "painting")) result.resolve(); }, () => {});
		return result.promise.finally(unsubscribe);
	};
	const variantId = chat.messages[0]!.variants[0]!.id;
	module.command(chat.id, { type: "paint", variantId, brief: "A scene", aspectRatio: "1:1" });
	await settled();
	const failure = module.read(chat.id).paintings[0]!;
	expect(failure).toMatchObject({ kind: "failed", message: "The provider refused this Brief." });
	expect(calls).toBe(1);
	module.command(chat.id, { type: "retry", variantId, id: failure.id });
	await settled();
	expect(module.read(chat.id).paintings).toMatchObject([{ kind: "illustration" }]);
	expect(calls).toBe(2);
	const rejected = createPaintingModule(database, { fetch: async () => Response.json({ data: [{ b64_json: Buffer.from("<svg></svg>").toString("base64") }] }) });
	rejected.command(chat.id, { type: "paint", variantId, brief: "Rejected media", aspectRatio: "1:1" });
	await settled();
	const invalid = module.read(chat.id).paintings.find((entry) => entry.kind === "failed")!;
	expect(invalid).toMatchObject({ kind: "failed", message: "Only PNG, JPEG, WebP, and GIF images are accepted." });
	module.command(chat.id, { type: "dismiss", variantId, id: invalid.id });
	expect(module.read(chat.id).paintings).toHaveLength(1);
	const held = createPaintingModule(database, { fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
	held.command(chat.id, { type: "paint", variantId, brief: "Abandoned", aspectRatio: "1:1" });
	processStateFor(database).dispose();
	expect(createPaintingModule(database).read(chat.id).paintings).toMatchObject([{ kind: "illustration" }]);
});

test("a Chat starts square without stored settings and remembers the writer's shape", () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const module = createPaintingModule(database);
	expect(module.read(chat.id).aspectRatio).toBe("1:1");
	expect(database.query("SELECT * FROM conversation_data WHERE namespace = 'painting'").all()).toHaveLength(0);
	module.command(chat.id, { type: "set-aspect-ratio", aspectRatio: "9:16" });
	expect(createPaintingModule(database).read(chat.id).aspectRatio).toBe("9:16");
});
