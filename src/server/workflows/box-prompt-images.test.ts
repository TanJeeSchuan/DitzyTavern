import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { formatImageReference } from "../../shared/image-reference";
import { builtInBoxes, loadBoxes } from "../box/registry";
import { closeBoxFrame, openBoxFrame, uploadBoxFrameImage } from "../box/frame";
import { sweepOrphanedImages } from "../image/store";
import { writeMessageMoves } from "../box/moves";
import { uploadImage } from "../image";
import { pngFixture } from "../image/image-fixtures";
import { importNativePromptPreset, selectConversationPromptPreset } from "../prompt-preset";
import { createConversationWithHistory, insertBox, openObservedDatabase, setBoxState } from "../test-fixtures/conversation";
import { captureGeneration, modelRequestFor, withGenerationBoxOperations } from "./generate-capture";
import { captureGenerationPreview, createGenerationPreviewAsync } from "./generation-preview";

const macroReference = (name: string, hash: string) => `![${name}](image:{{trim}}${hash})`;

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

const fixture = async (literal = false, instructions: (hash: string) => string = () => "", moveLabel: (hash: string) => string = () => "Look") => {
	const database = openObservedDatabase();
	cleanup.push(() => database.close());
	const portrait = await uploadImage(database, pngFixture({ width: 10 }));
	const scratch = join(import.meta.dir, "../../../.scratch");
	mkdirSync(scratch, { recursive: true });
	const folder = mkdtempSync(join(scratch, "box-prompt-images-"));
	mkdirSync(join(folder, "probe"));
	await Bun.write(join(folder, "probe/descriptor.json"), JSON.stringify({
		id: "probe", sdk: 2, label: "Probe", summary: "Tests prompt images.", role: "system", startsEnabled: false, instructions: instructions(portrait.hash),
		setup: { schema: { anyOf: [{ type: "string" }, { type: "object", properties: { image: { type: "string" } }, required: ["image"], additionalProperties: false }] }, initial: "" },
		moves: { schema: { type: "string" }, max: 1, label: moveLabel(portrait.hash) }, window: { icon: "box", size: { width: 12, height: 12 } },
	}));
	await Bun.write(join(folder, "probe/ui.js"), "");
	await Bun.write(join(folder, "probe/logic.js"), `export default {
		advance: { run: ({ setup }) => ({ items: [{ text: typeof setup === "string" ? setup : setup.image, priority: 1, literal: ${literal} }] }) },
		moves: { render: (move) => move }, read: () => ({ view: null }),
	};`);
	await loadBoxes([builtInBoxes, folder]);
	cleanup.push(async () => { await loadBoxes([builtInBoxes]); rmSync(folder, { recursive: true, force: true }); });
	const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
	const chat = createConversationWithHistory(database, {
		name: "Images", participants: [
			{ definition: { name: "Writer", prompt, openings: [] } },
			{ definition: { name: "Maren", prompt, openings: [], portrait: { hash: portrait.hash, focalX: 0.5, focalY: 0.5 } } },
		], control: { human: 0, model: 1 },
		messages: [0, 1].map((authorParticipantIndex) => ({
			timestamp: "2026-11-10T00:00:00Z", authorParticipantIndex,
			variants: [{ content: "Earlier prose.", timestamp: "2026-11-10T00:00:00Z", selected: true }],
		})),
	});
	const instance = insertBox(database, chat.id, "probe");
	const preset = importNativePromptPreset(database, { name: "Images", slots: [
		{ reference: "box:probe", enabled: true, role: "system", content: instructions(portrait.hash) },
		{ reference: "history", enabled: true },
		{ reference: "box:author-note", enabled: true, role: "system", content: "" },
	] });
	selectConversationPromptPreset(drizzle(database), { conversationId: chat.id, promptPresetId: preset.id });
	const token = openBoxFrame({ box: "probe", conversationId: chat.id, instance, version: undefined });
	cleanup.push(() => { closeBoxFrame(token); });
	const owned = await uploadBoxFrameImage(database, token, pngFixture({ width: 1500, height: 750 }));
	if (owned === undefined) throw new Error("The fixture's frame did not upload its image.");
	const setupStatement = database.query("INSERT OR REPLACE INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, 'box:probe', 'setup', ?)");
	const setup = (text: string | { image: string }) => setupStatement.run(chat.id, JSON.stringify(text));
	const options = { connection: null, conversationId: chat.id, tokenEstimator: () => 0 };
	const capture = (move?: string) => captureGeneration(database, { kind: "send", content: "Look.", ...move !== undefined && { moves: { probe: [move] } } }, options);
	return { database, chat, owned, portrait, setup, capture, options, token };
};

test.each([false, true])("a sandboxed advance's Image Reference sends pixels and charges tokens, literal=%s", async (literal) => {
	const { owned, setup, capture } = await fixture(literal);
	setup(formatImageReference("scene", owned.hash));
	const { plan } = await capture();
	expect(plan.promptPlan.images).toMatchObject([{ hash: owned.hash, name: "scene", disposition: "send", tokens: 1500 }]);
	expect(plan.budget.tokenEstimate).toBe(1500);
});

test("the trusted Author Note sends the writer's Image References without a Box grant", async () => {
	const { database, chat, portrait, capture } = await fixture();
	const text = formatImageReference("portrait", portrait.hash);
	database.query("INSERT OR REPLACE INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, 'box:author-note', 'setup', ?)").run(chat.id, JSON.stringify(text));
	const { plan } = await capture();
	expect(plan.promptPlan.images).toMatchObject([{ hash: portrait.hash, disposition: "send" }]);
	expect(plan.promptPlan.warnings).toEqual([]);
});

test.each([formatImageReference, macroReference])("an unchanged preview keeps its image guard and warning (%p)", async (reference) => {
	const { database, chat, portrait, setup } = await fixture();
	setup(reference("portrait", portrait.hash));
	const target = { kind: "send", content: "Look." } as const;
	const context = { database, conversationId: chat.id, connection: null };
	const record = await createGenerationPreviewAsync(database, { ...context, ...target });
	const capture = await withGenerationBoxOperations(context, () => captureGenerationPreview(context, { record, editedPlan: record.capture.plan.promptPlan }, target));
	expect(capture.plan.promptPlan.images).toEqual([]);
	expect(capture.plan.promptPlan.warnings).toContainEqual({ block: "Probe Box", macro: "portrait", reason: "ungranted-image" });
});

test.each([false, true])("sandboxed items and rendered Moves send only granted images, literal=%s", async (literal) => {
	const { database, owned, portrait, setup, capture } = await fixture(literal);
	const unowned = await uploadImage(database, pngFixture({ width: 11 }));
	const text = [formatImageReference("scene", owned.hash), formatImageReference("stray", unowned.hash), formatImageReference("portrait", portrait.hash)].join(" ");
	setup(text);
	const { plan } = await capture(text);
	expect(plan.promptPlan.images.map(({ hash, disposition }) => ({ hash, disposition }))).toEqual([
		{ hash: owned.hash, disposition: "send" }, { hash: owned.hash, disposition: "anchor" },
	]);
	for (const kind of ["box:probe", "history"]) {
		expect(plan.promptPlan.blocks.findLast((block) => block.kind === kind)?.content).toContain(`${formatImageReference("scene", owned.hash)} [Image: stray] [Image: portrait]`);
	}
	expect(plan.promptPlan.warnings).toEqual(expect.arrayContaining([
		{ block: "Probe Box", macro: "stray", reason: "ungranted-image" },
		{ block: "Probe Box", macro: "portrait", reason: "ungranted-image" },
	]));
	expect(plan.budget.tokenEstimate).toBe(1500);
});

test("macro-built item references cannot send ungranted images or Cast Portraits", async () => {
	const { database, owned, portrait, setup, capture } = await fixture();
	const unowned = await uploadImage(database, pngFixture({ width: 11 }));
	setup([macroReference("scene", owned.hash), macroReference("stray", unowned.hash), macroReference("portrait", portrait.hash)].join(" "));
	const { plan } = await capture();
	expect(plan.promptPlan.images).toMatchObject([{ hash: owned.hash, disposition: "send" }]);
	expect(plan.promptPlan.images).toHaveLength(1);
	expect(plan.promptPlan.blocks.find(({ kind }) => kind === "box:probe")?.content).toBe(`${formatImageReference("scene", owned.hash)} [Image: stray] [Image: portrait]`);
	for (const macro of ["stray", "portrait"]) expect(plan.promptPlan.warnings).toContainEqual({ block: "Probe Box", macro, reason: "ungranted-image" });
});

test.each([formatImageReference, macroReference])("Box descriptor instructions cannot send an ungranted portrait (%p)", async (reference) => {
	const { setup, capture } = await fixture(false, (hash) => reference("portrait", hash));
	setup("A scene.");
	const { plan } = await capture();
	expect(plan.promptPlan.images).toEqual([]);
	expect(plan.promptPlan.blocks.find(({ kind }) => kind === "box:probe")?.content).toBe("[Image: portrait]\nA scene.");
	expect(plan.promptPlan.warnings).toContainEqual({ block: "Probe Box", macro: "portrait", reason: "ungranted-image" });
});

test("sandboxed macro writes stay inside the Box instead of exporting image fragments", async () => {
	const { database, chat, portrait, setup, capture } = await fixture();
	setup(`{{setvar::leak::${portrait.hash}}}![portrait](image:{{getvar::leak}})`);
	const later = "![escaped](image:{{getvar::leak}})";
	database.query("INSERT OR REPLACE INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, 'box:author-note', 'setup', ?)").run(chat.id, JSON.stringify(later));
	const result = await capture();
	expect(result.plan.promptPlan.images).toEqual([]);
	expect(result.plan.promptPlan.blocks.find(({ kind }) => kind === "box:probe")?.content).toBe("[Image: portrait]");
	expect(result.macroWrites).toEqual([]);
});

test("disabled Move labels cannot send images, and the writer's prose still can", async () => {
	const { database, chat, portrait, capture } = await fixture(false, () => "", (hash) => formatImageReference("label", hash));
	const message = chat.messages[0];
	const variant = message?.variants[0];
	if (message === undefined || variant === undefined) throw new Error("The fixture has no history.");
	writeMessageMoves(drizzle(database), message.id, { probe: ["look"] });
	database.query("UPDATE message_variant SET content = ? WHERE id = ?").run(formatImageReference("writer", portrait.hash), variant.id);
	setBoxState(database, chat.id, "probe", "disabled");
	const { plan } = await capture();
	expect(plan.promptPlan.images).toMatchObject([{ name: "writer", hash: portrait.hash, disposition: "send" }]);
	expect(plan.promptPlan.images).toHaveLength(1);
	expect(plan.promptPlan.blocks.find(({ kind }) => kind === "history")?.content).toBe(`[Image: label]\n${formatImageReference("writer", portrait.hash)}`);
	expect(plan.promptPlan.warnings).toContainEqual({ block: "Probe Box", macro: "label", reason: "ungranted-image" });
});

test("the documented setup handoff retains the upload beyond the orphan grace period", async () => {
	const { database, chat, owned, token, setup } = await fixture();
	const bare = await uploadBoxFrameImage(database, token, pngFixture({ width: 12 }));
	if (bare === undefined) throw new Error("The fixture's frame did not upload its image.");
	setup({ image: formatImageReference("scene", owned.hash) });
	database.query("INSERT INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, 'box:probe', 'draft', ?)").run(chat.id, JSON.stringify({ image: bare.hash }));
	sweepOrphanedImages(database, Date.now() + 25 * 60 * 60 * 1000);
	expect(database.query("SELECT hash FROM image WHERE hash = ?").get(owned.hash)).not.toBeNull();
	expect(database.query("SELECT hash FROM image WHERE hash = ?").get(bare.hash)).toBeNull();
	expect(database.query("SELECT hash FROM box_image_grant WHERE hash = ?").get(owned.hash)).not.toBeNull();
});

test("writer edits to a preview may add an ungranted image to the Box block", async () => {
	const { database, chat, portrait, setup } = await fixture();
	setup(macroReference("portrait", portrait.hash));
	const target = { kind: "send", content: "Look." } as const;
	const context = { database, conversationId: chat.id, connection: null };
	const record = await createGenerationPreviewAsync(database, { ...context, ...target });
	const editedPlan = structuredClone(record.capture.plan.promptPlan);
	const block = editedPlan.blocks.find(({ kind }) => kind === "box:probe");
	if (block === undefined) throw new Error("The fixture has no Box block.");
	block.content = formatImageReference("writer", portrait.hash);
	const capture = await withGenerationBoxOperations(context, () => captureGenerationPreview(context, { record, editedPlan }, target));
	expect(capture.plan.promptPlan.images).toMatchObject([{ name: "writer", hash: portrait.hash, disposition: "send" }]);
});

test.each(["send", "sibling", "continuation"] as const)("%s keeps rendered Moves literal and guards their images apart from writer prose", async (kind) => {
	const { database, chat, portrait, owned, options, setup } = await fixture();
	const humanMessage = chat.messages[0];
	const modelMessage = chat.messages[1];
	const variant = humanMessage?.variants[0];
	const human = chat.cast[0];
	const model = chat.cast[1];
	if (humanMessage === undefined || modelMessage === undefined || variant === undefined || human === undefined || model === undefined) throw new Error("The fixture has no history.");
	const rendered = [formatImageReference("scene", owned.hash), formatImageReference("blocked", portrait.hash), macroReference("literal", portrait.hash)].join(" ");
	const prose = formatImageReference("writer", portrait.hash);
	writeMessageMoves(drizzle(database), humanMessage.id, { probe: [rendered] });
	database.query("UPDATE message_variant SET content = ? WHERE id = ?").run(prose, variant.id);
	database.query("UPDATE messages SET context_human_participant_id = ?, context_model_participant_id = ? WHERE id = ?").run(human.id, model.id, modelMessage.id);
	setup(macroReference("item", portrait.hash));
	const target = kind === "send" ? { kind, content: prose, moves: { probe: [rendered] } }
		: kind === "sibling" ? { kind, messageId: modelMessage.id, reroll: true } : { kind };
	if (kind === "continuation") {
		database.query("UPDATE conversation_generation_settings SET continuation_strategy = 'assistant-prefill' WHERE conversation_id = ?").run(chat.id);
		writeMessageMoves(drizzle(database), modelMessage.id, { probe: [formatImageReference("prefix", portrait.hash)] });
	}
	const capture = await captureGeneration(database, target, options);
	const { plan } = capture;
	if (kind === "continuation") expect(modelRequestFor(capture, { signal: undefined }).assistantPrefill?.prefix).toBe("[Image: prefix]\nEarlier prose.");
	expect(plan.promptPlan.images.every(({ name }) => name === "scene" || name === "writer")).toBe(true);
	expect(plan.promptPlan.images.some(({ name, disposition }) => name === "writer" && disposition === "send")).toBe(true);
	expect(plan.promptPlan.blocks.find(({ kind }) => kind === "history")?.content).toBe(`${formatImageReference("scene", owned.hash)} [Image: blocked] ${macroReference("literal", portrait.hash)}\n${prose}`);
	for (const macro of ["blocked", "item"]) expect(plan.promptPlan.warnings).toContainEqual({ block: "Probe Box", macro, reason: "ungranted-image" });
});
