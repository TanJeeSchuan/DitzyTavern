import { prepareConversationEffects } from "../application/conversation-effects";
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
import { imageLoader, uploadImage, sweepOrphanedImages } from "../image";
import { forkConversation } from "../conversation";
import { formatImageReference } from "../../shared/image-reference";
import { processStateFor } from "../application/process-state";
import { subscribeDatabaseChanges, watchDatabaseChanges } from "../database/changes";

const setup = () => {
	initializeConnectionSecretKey({ environment: { CONNECTION_SECRET_KEY: Buffer.alloc(32, 1).toString("base64") } });
	const database = openObservedDatabase();
	const connections = createConnectionSettingsModule(database);
	connections.createProfile({ expectedRevision: 0, profile: { ...blankConnectionProfileDraft, displayName: "Painter", apiFormat: "images", adapter: "openrouter", requestUrl: "https://example.com/images" } });
	applyImageModelSettings(database, { type: "apply", expectedRevision: 0, profileId: connections.get().profiles[0]!.id, model: "painter" });
	const prompt = { systemInstruction: "", identity: "", appearance: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
	const chat = createConversationWithHistory(database, { name: "Painting", participants: [
		{ definition: { name: "Writer", prompt, sendAppearanceImages: true, openings: [] } },
		{ definition: { name: "Maren", prompt, sendAppearanceImages: true, openings: ["First scene", "Other scene"] } },
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
	module.command(chat.id, { type: "paint", ask: "", variantId, brief: "Private painted scene", aspectRatio: "3:4" });
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
	const finishedPlans = JSON.stringify(await plans());
	expect(finishedPlans).not.toContain("Private painted scene");
	expect(finishedPlans).not.toContain(painting.image.slice(6));
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
	module.command(chat.id, { type: "paint", ask: "", variantId, brief: "A scene", aspectRatio: "1:1" });
	await settled();
	const failure = module.read(chat.id).paintings[0]!;
	expect(failure).toMatchObject({ kind: "failed", message: "The provider refused this Brief." });
	expect(calls).toBe(1);
	module.command(chat.id, { type: "retry", variantId, id: failure.id });
	await settled();
	expect(module.read(chat.id).paintings).toMatchObject([{ kind: "illustration" }]);
	expect(calls).toBe(2);
	const rejected = createPaintingModule(database, { fetch: async () => Response.json({ data: [{ b64_json: Buffer.from("<svg></svg>").toString("base64") }] }) });
	rejected.command(chat.id, { type: "paint", ask: "", variantId, brief: "Rejected media", aspectRatio: "1:1" });
	await settled();
	const invalid = module.read(chat.id).paintings.find((entry) => entry.kind === "failed")!;
	expect(invalid).toMatchObject({ kind: "failed", message: "Only PNG, JPEG, WebP, and GIF images are accepted." });
	module.command(chat.id, { type: "dismiss", variantId, id: invalid.id });
	expect(module.read(chat.id).paintings).toHaveLength(1);
	const held = createPaintingModule(database, { fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
	held.command(chat.id, { type: "paint", ask: "", variantId, brief: "Abandoned", aspectRatio: "1:1" });
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

test("concurrent paintings keep their starting positions when the later picture finishes first", async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const first = Promise.withResolvers<Response>();
	const second = Promise.withResolvers<Response>();
	const module = createPaintingModule(database, { fetch: (_url, init) => JSON.parse(String(init?.body)).prompt === "First" ? first.promise : second.promise });
	const variantId = chat.messages[0]!.variants[0]!.id;
	module.command(chat.id, { type: "paint", ask: "", variantId, brief: "First", aspectRatio: "9:16" });
	module.command(chat.id, { type: "paint", ask: "", variantId, brief: "Second", aspectRatio: "16:9" });
	const ids = module.read(chat.id).paintings.map((painting) => painting.id);
	const finish = async (reply: typeof first, brief: string) => {
		const finished = Promise.withResolvers<void>();
		const unsubscribe = subscribeDatabaseChanges(database, () => { if (module.read(chat.id).paintings.some((painting) => painting.kind === "illustration" && painting.brief === brief)) finished.resolve(); }, () => {});
		reply.resolve(Response.json({ data: [{ b64_json: pngFixture().toString("base64") }] }));
		await finished.promise;
		unsubscribe();
	};
	await finish(second, "Second");
	expect(module.read(chat.id).paintings.map((painting) => painting.id)).toEqual(ids);
	await finish(first, "First");
	expect(createPaintingModule(database).read(chat.id).paintings.map((painting) => painting.id)).toEqual(ids);
	expect(module.read(chat.id).paintings.map((painting) => painting.brief)).toEqual(["First", "Second"]);
});

test("deleting a Variant aborts only its painting and discards a late provider reply", async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	observeConversationWrites(database, prepareConversationEffects);
	const reply = Promise.withResolvers<Response>();
	const started = Promise.withResolvers<AbortSignal>();
	const module = createPaintingModule(database, { fetch: (_url, init) => {
		if (!init?.signal) throw new Error("Missing painting signal");
		started.resolve(init.signal);
		return reply.promise;
	} });
	const message = chat.messages[0]!;
	const variantId = message.variants[0]!.id;
	module.command(chat.id, { type: "paint", ask: "", variantId, brief: "Removed scene", aspectRatio: "1:1" });
	const signal = await started.promise;
	executeConversationCommand(database, { conversationId: chat.id, expectedRevision: chat.revision, action: { type: "delete-variant", messageId: message.id, variantId } });
	expect(signal.aborted).toBe(true);
	expect([...processStateFor(database).paintings.forVariant(variantId)]).toEqual([]);
	reply.resolve(Response.json({ data: [{ b64_json: pngFixture().toString("base64") }] }));
	await paintAndWait(fixture, message.variants[1]!.id, "Surviving scene");
	expect(module.read(chat.id).paintings).toMatchObject([{ kind: "illustration", brief: "Surviving scene" }]);
	expect(database.query("SELECT * FROM message_variant_data WHERE namespace = 'painting' AND message_variant_id = ?").all(variantId)).toEqual([]);
	expect(database.query("SELECT * FROM image").all()).toHaveLength(1);
});

const paintAndWait = async (fixture: ReturnType<typeof setup>, variantId: number, brief: string) => {
	const module = createPaintingModule(fixture.database, { fetch: async () => Response.json({ data: [{ b64_json: pngFixture({ width: 320 }).toString("base64") }] }) });
	module.command(fixture.chat.id, { type: "paint", ask: "", variantId, brief, aspectRatio: "4:3" });
	const finished = Promise.withResolvers<void>();
	const unsubscribe = subscribeDatabaseChanges(fixture.database, () => {
		if (module.read(fixture.chat.id).paintings.some((painting) => painting.kind === "illustration" && painting.brief === brief)) finished.resolve();
	}, () => {});
	await finished.promise;
	unsubscribe();
	return module;
};

test("Delete removes only its Illustration without a Conversation Revision or touched Variant", async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const variantId = chat.messages[0]!.variants[0]!.id;
	const module = await paintAndWait(fixture, variantId, "First picture");
	await paintAndWait(fixture, variantId, "Keep this picture");
	const first = module.read(chat.id).paintings[0]!;
	let writes = 0;
	observeConversationWrites(database, () => { writes++; return () => {}; });
	module.command(chat.id, { type: "delete", variantId, id: first.id });
	expect(module.read(chat.id).paintings).toMatchObject([{ kind: "illustration", brief: "Keep this picture" }]);
	expect(readConversationSummary(database, chat.id)?.revision).toBe(chat.revision);
	expect(writes).toBe(0);
});

test("Fork copies Illustrations to its Variants and Trim Variants drops the unselected Illustration", async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const message = chat.messages[0]!;
	const module = await paintAndWait(fixture, message.variants[0]!.id, "Selected scene");
	await paintAndWait(fixture, message.variants[1]!.id, "Other scene");
	const fork = (trimVariants: boolean) => forkConversation(database, { conversationId: chat.id, expectedRevision: chat.revision, at: { through: message.id }, name: "Painted Fork", trimVariants }).conversation;
	const copied = module.read(fork(false).id).paintings;
	expect(copied.map(({ brief }) => brief)).toEqual(["Selected scene", "Other scene"]);
	expect(copied.every(({ variantId }) => !message.variants.some(({ id }) => id === variantId))).toBe(true);
	expect(module.read(fork(true).id).paintings.map(({ brief }) => brief)).toEqual(["Selected scene"]);
	expect(module.read(chat.id).paintings.map(({ brief }) => brief)).toEqual(["Selected scene", "Other scene"]);
});

for (const removal of ["Illustration", "Variant"] as const) test(`an Illustration's picture and Brief references survive the sweep until its ${removal} is deleted`, async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const reference = await uploadImage(database, pngFixture({ width: 16 }));
	const message = chat.messages[0]!;
	const variantId = message.variants[0]!.id;
	const module = await paintAndWait(fixture, variantId, `A lake ${formatImageReference("Lake", reference.hash)}`);
	const painting = module.read(chat.id).paintings[0]!;
	if (painting.kind !== "illustration") throw new Error("Illustration missing");
	const hashes = [painting.image.slice(6), reference.hash];
	const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
	sweepOrphanedImages(database, later);
	for (const hash of hashes) expect(imageLoader(database)(hash)).toBeDefined();
	if (removal === "Illustration") module.command(chat.id, { type: "delete", variantId, id: painting.id });
	else executeConversationCommand(database, { conversationId: chat.id, expectedRevision: chat.revision, action: { type: "delete-variant", messageId: message.id, variantId } });
	expect(module.read(chat.id).paintings).toEqual([]);
	sweepOrphanedImages(database, later);
	sweepOrphanedImages(database, later + 24 * 60 * 60 * 1000 + 1);
	for (const hash of hashes) expect(imageLoader(database)(hash)).toBeUndefined();
});

test("the gallery includes every Variant, Cast Portraits and Appearance, without duplicate Images", async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const repeated = await uploadImage(database, pngFixture({ width: 16, height: 16 }));
	const unselected = await uploadImage(database, pngFixture({ width: 24, height: 16 }));
	const portrait = await uploadImage(database, pngFixture({ width: 32, height: 16 }));
	const appearance = await uploadImage(database, pngFixture({ width: 40, height: 16 }));
	const message = chat.messages[0]!;
	database.query("UPDATE message_variant SET content = ? WHERE id = ?").run(formatImageReference("Repeated", repeated.hash).repeat(2), message.variants[0]!.id);
	database.query("UPDATE message_variant SET content = ? WHERE id = ?").run(formatImageReference("Other Swipe", unselected.hash), message.variants[1]!.id);
	database.query("UPDATE participant_prompt SET portrait_hash = ?, portrait_focal_x = 0.5, portrait_focal_y = 0.5 WHERE participant_id = ?").run(portrait.hash, chat.control.modelParticipantId);
	database.query("UPDATE participant_prompt SET appearance = ?, send_appearance_images = 0 WHERE participant_id = ?").run(formatImageReference("Appearance", appearance.hash), chat.control.modelParticipantId);
	await paintAndWait(fixture, message.variants[1]!.id, "Hidden Illustration");
	const module = createPaintingModule(database);
	const painted = module.read(chat.id).paintings[0]!;
	if (painted.kind !== "illustration") throw new Error("Missing Illustration");
	expect(module.gallery(chat.id)).toEqual([
		{ hash: painted.image.slice(6), name: "Illustration" },
		{ hash: repeated.hash, name: "Repeated" }, { hash: unselected.hash, name: "Other Swipe" },
		{ hash: portrait.hash, name: "Maren Portrait" }, { hash: appearance.hash, name: "Appearance" },
	]);
});
