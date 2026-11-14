import { prepareConversationEffects } from "../application/conversation-effects";
import { createGenerationPreviewAsync } from "../workflows/generation-preview";
import { expect, test } from "bun:test";
import { createConversationWithHistory, openObservedDatabase, checkpointFromStart } from "../test-fixtures/conversation";
import { executeConversationCommand, readConversationSummary, observeConversationWrites, acceptConversationContinuationGeneration } from "../conversation";
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
	module.command(chat.id, { type: "paint", ask: "", references: "", variantId, brief: "Private painted scene", aspectRatio: "3:4" });
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
	module.command(chat.id, { type: "paint", ask: "", references: "", variantId, brief: "A scene", aspectRatio: "1:1" });
	await settled();
	const failure = module.read(chat.id).paintings[0]!;
	expect(failure).toMatchObject({ kind: "failed", message: "The provider refused this Brief." });
	expect(calls).toBe(1);
	module.command(chat.id, { type: "retry", variantId, id: failure.id });
	await settled();
	expect(module.read(chat.id).paintings).toMatchObject([{ kind: "illustration" }]);
	expect(calls).toBe(2);
	const rejected = createPaintingModule(database, { fetch: async () => Response.json({ data: [{ b64_json: Buffer.from("<svg></svg>").toString("base64") }] }) });
	rejected.command(chat.id, { type: "paint", ask: "", references: "", variantId, brief: "Rejected media", aspectRatio: "1:1" });
	await settled();
	const invalid = module.read(chat.id).paintings.find((entry) => entry.kind === "failed")!;
	expect(invalid).toMatchObject({ kind: "failed", message: "Only PNG, JPEG, WebP, and GIF images are accepted." });
	module.command(chat.id, { type: "dismiss", variantId, id: invalid.id });
	expect(module.read(chat.id).paintings).toHaveLength(1);
	const held = createPaintingModule(database, { fetch: (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })) });
	held.command(chat.id, { type: "paint", ask: "", references: "", variantId, brief: "Abandoned", aspectRatio: "1:1" });
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
	module.command(chat.id, { type: "paint", ask: "", references: "", variantId, brief: "First", aspectRatio: "9:16" });
	module.command(chat.id, { type: "paint", ask: "", references: "", variantId, brief: "Second", aspectRatio: "16:9" });
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
	module.command(chat.id, { type: "paint", ask: "", references: "", variantId, brief: "Removed scene", aspectRatio: "1:1" });
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
	module.command(fixture.chat.id, { type: "paint", ask: "", references: "", variantId, brief, aspectRatio: "4:3" });
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
	database.query("UPDATE message_variant SET content = ? WHERE id = ?").run(formatImageReference("Repeated", repeated.hash) + formatImageReference("Later name", repeated.hash), message.variants[0]!.id);
	database.query("UPDATE message_variant SET content = ? WHERE id = ?").run(formatImageReference("Other Swipe", unselected.hash), message.variants[1]!.id);
	database.query("UPDATE participant_prompt SET portrait_hash = ?, portrait_focal_x = 0.5, portrait_focal_y = 0.5 WHERE participant_id = ?").run(portrait.hash, chat.control.modelParticipantId);
	database.query("UPDATE participant_prompt SET appearance = ?, send_appearance_images = 0 WHERE participant_id = ?").run(formatImageReference("Appearance", appearance.hash), chat.control.modelParticipantId);
	await paintAndWait(fixture, message.variants[1]!.id, "Hidden Illustration");
	const module = createPaintingModule(database);
	const painted = module.read(chat.id).paintings[0]!;
	if (painted.kind !== "illustration") throw new Error("Missing Illustration");
	expect(module.gallery(chat.id)).toEqual([
		{ hash: painted.image.slice(6), name: "Illustration", source: "painter", painted: { brief: "Hidden Illustration", references: "", ask: "" } },
		{ hash: repeated.hash, name: "Repeated", source: "Message" }, { hash: unselected.hash, name: "Other Swipe", source: "Message" },
		{ hash: portrait.hash, name: "Maren Portrait", source: "Maren" }, { hash: appearance.hash, name: "Appearance", source: "Maren" },
	]);
});


test("the gallery includes live Image References while a Generation is active", async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const image = await uploadImage(database, pngFixture({ width: 72, height: 32 }));
	const opening = chat.messages[0]!;
	const active = acceptConversationContinuationGeneration(database, {
		generationIntent: { type: "continuation", strategy: "instruction", instruction: "Continue." },
		seed: "gallery-generation", conversationId: chat.id, expectedRevision: chat.revision, timestamp: "2026-11-12T00:00:00Z",
		precedingMessageId: opening.id, precedingVariantId: opening.variants[0]!.id,
		humanParticipantId: chat.control.humanParticipantId!, modelParticipantId: chat.control.modelParticipantId!,
		capturedHumanName: "Writer", capturedModelName: "Maren", modelId: "fixture-model",
		promptPlan: { blocks: [], warnings: [], images: [] },
		promptInspection: { tokenEstimate: 0, responseBudget: 64, safetyAllowance: 0, contextLimit: 128, totalRequiredTokens: 64, omittedContext: [] },
	});
	checkpointFromStart(database, { conversationId: chat.id, generationId: active.generationId, content: formatImageReference("Live picture", image.hash) });
	expect(createPaintingModule(database).gallery(chat.id)).toEqual([{ hash: image.hash, name: "Live picture", source: "Message" }]);
});

test("Remove, keep in Gallery takes an Illustration off its Message but keeps it in the Gallery, through the sweep and a Fork, until removed from that Chat's Gallery", async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const message = chat.messages[0]!;
	const variantId = message.variants[0]!.id;
	const module = await paintAndWait(fixture, variantId, "Kept scene");
	const painting = module.read(chat.id).paintings[0]!;
	if (painting.kind !== "illustration") throw new Error("Illustration missing");
	const kept = [{ hash: painting.image.slice(6), name: "Illustration", source: "painter", keptId: painting.id, painted: { brief: "Kept scene", references: "", ask: "" } }];
	module.command(chat.id, { type: "keep-in-gallery", variantId, id: painting.id });
	expect(module.read(chat.id).paintings).toEqual([]);
	expect(module.gallery(chat.id)).toEqual(kept);
	const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
	sweepOrphanedImages(database, later);
	sweepOrphanedImages(database, later + 24 * 60 * 60 * 1000 + 1);
	expect(imageLoader(database)(painting.image.slice(6))).toBeDefined();
	const fork = forkConversation(database, { conversationId: chat.id, expectedRevision: chat.revision, at: { through: message.id }, name: "Kept Fork", trimVariants: false }).conversation;
	expect(module.gallery(fork.id)).toEqual(kept);
	module.command(chat.id, { type: "remove-from-gallery", id: painting.id });
	expect(module.gallery(chat.id)).toEqual([]);
	expect(module.gallery(fork.id)).toEqual(kept);
});

test("an uploaded picture joins the Chat's Gallery once, through the sweep, until one removal, and a missing picture is refused", async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const module = createPaintingModule(database);
	const { hash } = await uploadImage(database, pngFixture({ width: 32 }));
	expect(() => module.command(chat.id, { type: "add-to-gallery", hash: "0".repeat(64), name: "Ghost" })).toThrow("The image is missing; upload it again.");
	module.command(chat.id, { type: "add-to-gallery", hash, name: "Harbour" });
	module.command(chat.id, { type: "add-to-gallery", hash, name: "Harbour again" });
	const [uploaded] = module.gallery(chat.id);
	expect(module.gallery(chat.id)).toEqual([{ hash, name: "Harbour", source: "Uploaded", keptId: expect.any(String) }]);
	const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
	sweepOrphanedImages(database, later);
	sweepOrphanedImages(database, later + 24 * 60 * 60 * 1000 + 1);
	expect(imageLoader(database)(hash)).toBeDefined();
	module.command(chat.id, { type: "remove-from-gallery", id: uploaded!.keptId! });
	expect(module.gallery(chat.id)).toEqual([]);
});

test("a kept Illustration stays removable from the Gallery while an attached Illustration shows the same picture", async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const variantId = chat.messages[0]!.variants[0]!.id;
	const module = await paintAndWait(fixture, variantId, "First take");
	await paintAndWait(fixture, variantId, "Same picture again");
	const [kept, attached] = module.read(chat.id).paintings;
	if (kept?.kind !== "illustration" || attached?.kind !== "illustration" || kept.image !== attached.image) throw new Error("Two Illustrations of one picture missing");
	module.command(chat.id, { type: "keep-in-gallery", variantId, id: kept.id });
	const shown = { hash: kept.image.slice(6), name: "Illustration", source: "painter", painted: { brief: "Same picture again", references: "", ask: "" } };
	expect(module.gallery(chat.id)).toEqual([{ ...shown, keptId: kept.id }]);
	module.command(chat.id, { type: "remove-from-gallery", id: kept.id });
	expect(module.gallery(chat.id)).toEqual([shown]);
});

test("the Image Model receives the Brief, a separator and the References, with each Image once in order, and the Illustration keeps both", async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const lake = await uploadImage(database, pngFixture({ width: 16 }));
	const face = await uploadImage(database, pngFixture({ width: 24 }));
	const requests: string[] = [];
	const module = createPaintingModule(database, { fetch: async (_url, init) => {
		requests.push(String(init?.body));
		return Response.json({ data: [{ b64_json: pngFixture().toString("base64") }] });
	} });
	const variantId = chat.messages[0]!.variants[0]!.id;
	const references = `Maren: ${formatImageReference("Face", face.hash)} ${formatImageReference("Lake again", lake.hash)}`;
	module.command(chat.id, { type: "paint", ask: "", references, variantId, brief: `A lake ${formatImageReference("Lake", lake.hash)}`, aspectRatio: "1:1" });
	const finished = Promise.withResolvers<void>();
	const unsubscribe = subscribeDatabaseChanges(database, () => { if (module.read(chat.id).paintings.some((painting) => painting.kind === "illustration")) finished.resolve(); }, () => {});
	await finished.promise;
	unsubscribe();
	const body = JSON.parse(requests[0]!);
	expect(body.prompt).toBe("A lake [Image: Lake]\n\n---\n\nMaren: [Image: Face] [Image: Lake again]");
	const png = (hash: string) => `data:image/png;base64,${Buffer.from(imageLoader(database)(hash)!.bytes).toString("base64")}`;
	expect(body.input_references.map(({ image_url }: { image_url: { url: string } }) => image_url.url)).toEqual([png(lake.hash), png(face.hash)]);
	expect(module.read(chat.id).paintings).toMatchObject([{ kind: "illustration", brief: `A lake ${formatImageReference("Lake", lake.hash)}`, references }]);
});

test("Reference Sets: one empty set before any exists, New selects its copy, edits and the selection survive a reload and a Fork, deleting the selected set selects another", () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const module = createPaintingModule(database);
	expect(module.read(chat.id)).toMatchObject({ referenceSets: [{ id: "default", name: "References", references: "" }], referenceSetId: "default" });
	module.command(chat.id, { type: "save-reference-set", id: "default", references: "Kiseki: racing silks" });
	module.command(chat.id, { type: "rename-reference-set", id: "default", name: "Race day" });
	module.command(chat.id, { type: "create-reference-set", name: " Kimono ", references: "Kiseki: racing silks" });
	const kimono = module.read(chat.id).referenceSets.find(({ name }) => name === "Kimono")!;
	module.command(chat.id, { type: "save-reference-set", id: kimono.id, references: "Kiseki: kimono" });
	const expected = { referenceSets: [{ id: kimono.id, name: "Kimono", references: "Kiseki: kimono" }, { id: "default", name: "Race day", references: "Kiseki: racing silks" }], referenceSetId: kimono.id };
	expect(createPaintingModule(database).read(chat.id)).toMatchObject(expected);
	const fork = forkConversation(database, { conversationId: chat.id, expectedRevision: chat.revision, at: { through: chat.messages[0]!.id }, name: "Fork", trimVariants: false }).conversation;
	expect(module.read(fork.id)).toMatchObject(expected);
	module.command(chat.id, { type: "delete-reference-set", id: kimono.id });
	expect(module.read(chat.id)).toMatchObject({ referenceSets: [{ id: "default", name: "Race day" }], referenceSetId: "default" });
	expect(module.read(fork.id).referenceSets).toHaveLength(2);
	expect(() => module.command(chat.id, { type: "delete-reference-set", id: "default" })).toThrow("Keep at least one Reference Set.");
	expect(module.read(chat.id).referenceSets).toMatchObject([{ id: "default", references: "Kiseki: racing silks" }]);
});

test("adopting an Illustration's References selects the set holding them now, or creates one, and a blank name is refused", () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const module = createPaintingModule(database);
	module.command(chat.id, { type: "save-reference-set", id: "default", references: "Kiseki: kimono" });
	module.command(chat.id, { type: "create-reference-set", name: "Race", references: "Kiseki: racing silks" });
	module.command(chat.id, { type: "adopt-reference-set", name: "Bridge", references: "Kiseki: kimono" });
	expect(module.read(chat.id)).toMatchObject({ referenceSets: [{ name: "Race" }, { id: "default" }], referenceSetId: "default" });
	module.command(chat.id, { type: "save-reference-set", id: "default", references: "Kiseki: kimono, hair down" });
	module.command(chat.id, { type: "adopt-reference-set", name: "Bridge", references: "Kiseki: kimono" });
	const { referenceSets, referenceSetId } = module.read(chat.id);
	expect(referenceSets.find(({ id }) => id === referenceSetId)).toMatchObject({ name: "Bridge", references: "Kiseki: kimono" });
	expect(referenceSets).toHaveLength(3);
	for (const command of [{ type: "create-reference-set", name: "   ", references: "" }, { type: "rename-reference-set", id: "default", name: " " }] as const) {
		expect(() => module.command(chat.id, command)).toThrow("Name the Reference Set.");
	}
	expect(() => module.read(chat.id)).not.toThrow();
});

for (const [reply, message] of [
	[new Response("Content moderated: try another Brief.", { status: 400, headers: { "content-type": "text/plain" } }), "Content moderated: try another Brief."],
	[new Response(null, { status: 503 }), "The provider request failed with HTTP 503."],
] as const) test(`a provider refusal without a JSON error still names the failure: ${message}`, async () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const module = createPaintingModule(database, { fetch: async () => reply });
	const variantId = chat.messages[0]!.variants[0]!.id;
	const failed = Promise.withResolvers<void>();
	const unsubscribe = subscribeDatabaseChanges(database, () => { if (module.read(chat.id).paintings.some((painting) => painting.kind === "failed")) failed.resolve(); }, () => {});
	module.command(chat.id, { type: "paint", ask: "", references: "", variantId, brief: "A scene", aspectRatio: "1:1" });
	await failed.promise;
	unsubscribe();
	expect(module.read(chat.id).paintings).toMatchObject([{ kind: "failed", message }]);
});

test("deleting the selected Reference Set remembers its replacement, so renaming another set keeps the selection", () => {
	using fixture = setup();
	const { database, chat } = fixture;
	const module = createPaintingModule(database);
	module.command(chat.id, { type: "rename-reference-set", id: "default", name: "A" });
	module.command(chat.id, { type: "create-reference-set", name: "C", references: "Kiseki: C" });
	module.command(chat.id, { type: "create-reference-set", name: "B", references: "Kiseki: B" });
	const b = module.read(chat.id).referenceSetId;
	module.command(chat.id, { type: "delete-reference-set", id: b });
	expect(module.read(chat.id).referenceSetId).toBe("default");
	module.command(chat.id, { type: "rename-reference-set", id: "default", name: "Z" });
	expect(module.read(chat.id).referenceSetId).toBe("default");
	module.command(chat.id, { type: "save-reference-set", id: b, references: "Typed after the delete" });
	expect(module.read(chat.id).referenceSets.map(({ name }) => name)).toEqual(["C", "Z"]);
});
