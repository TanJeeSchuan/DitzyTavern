import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { formatImageReference } from "../../shared/image-reference";
import { builtInBoxes, loadBoxes } from "../box/registry";
import { closeBoxFrame, openBoxFrame, uploadBoxFrameImage } from "../box/frame";
import { uploadImage } from "../image";
import { pngFixture } from "../image/image-fixtures";
import { importNativePromptPreset, selectConversationPromptPreset } from "../prompt-preset";
import { createConversationWithHistory, insertBox, openObservedDatabase } from "../test-fixtures/conversation";
import { captureGeneration, withGenerationBoxOperations } from "./generate-capture";
import { captureGenerationPreview, createGenerationPreviewAsync } from "./generation-preview";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

const fixture = async (literal = false) => {
	const scratch = join(import.meta.dir, "../../../.scratch");
	mkdirSync(scratch, { recursive: true });
	const folder = mkdtempSync(join(scratch, "box-prompt-images-"));
	mkdirSync(join(folder, "probe"));
	await Bun.write(join(folder, "probe/descriptor.json"), JSON.stringify({
		id: "probe", sdk: 2, label: "Probe", summary: "Tests prompt images.", role: "system", startsEnabled: false, instructions: "",
		setup: { schema: { type: "string" }, initial: "" }, moves: { schema: { type: "string" }, max: 1, label: "Look" }, window: { icon: "box", size: { width: 12, height: 12 } },
	}));
	await Bun.write(join(folder, "probe/ui.js"), "");
	await Bun.write(join(folder, "probe/logic.js"), `export default {
		advance: { run: ({ setup }) => ({ items: [{ text: setup, priority: 1, literal: ${literal} }] }) },
		moves: { render: (move) => move }, read: () => ({ view: null }),
	};`);
	await loadBoxes([builtInBoxes, folder]);
	cleanup.push(async () => { await loadBoxes([builtInBoxes]); rmSync(folder, { recursive: true, force: true }); });
	const database = openObservedDatabase();
	cleanup.push(() => database.close());
	const portrait = await uploadImage(database, pngFixture({ width: 10 }));
	const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };
	const chat = createConversationWithHistory(database, {
		name: "Images", participants: [
			{ definition: { name: "Writer", prompt, openings: [] } },
			{ definition: { name: "Maren", prompt, openings: [], portrait: { hash: portrait.hash, focalX: 0.5, focalY: 0.5 } } },
		], control: { human: 0, model: 1 },
	});
	const instance = insertBox(database, chat.id, "probe");
	const preset = importNativePromptPreset(database, { name: "Images", slots: [
		{ reference: "box:probe", enabled: true, role: "system", content: "" },
		{ reference: "history", enabled: true },
		{ reference: "box:author-note", enabled: true, role: "system", content: "" },
	] });
	selectConversationPromptPreset(drizzle(database), { conversationId: chat.id, promptPresetId: preset.id });
	const token = openBoxFrame({ box: "probe", conversationId: chat.id, instance, version: undefined });
	cleanup.push(() => { closeBoxFrame(token); });
	const owned = await uploadBoxFrameImage(database, token, pngFixture({ width: 1500, height: 750 }));
	if (owned === undefined) throw new Error("The fixture's frame did not upload its image.");
	const setupStatement = database.query("INSERT OR REPLACE INTO conversation_data (conversation_id, namespace, key, value) VALUES (?, 'box:probe', 'setup', ?)");
	const setup = (text: string) => setupStatement.run(chat.id, JSON.stringify(text));
	const options = { connection: null, conversationId: chat.id, tokenEstimator: () => 0 };
	const capture = (move?: string) => captureGeneration(database, { kind: "send", content: "Look.", ...move !== undefined && { moves: { probe: [move] } } }, options);
	return { database, chat, owned, portrait, setup, capture };
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

test("an unchanged preview with an ungranted item remains sendable and keeps its warning", async () => {
	const { database, chat, portrait, setup } = await fixture();
	setup(formatImageReference("portrait", portrait.hash));
	const target = { kind: "send", content: "Look." } as const;
	const context = { database, conversationId: chat.id, connection: null };
	const record = await createGenerationPreviewAsync(database, { ...context, ...target });
	const capture = await withGenerationBoxOperations(context, () => captureGenerationPreview(context, { record, editedPlan: record.capture.plan.promptPlan }, target));
	expect(capture.plan.promptPlan.images).toEqual([]);
	expect(capture.plan.promptPlan.warnings).toContainEqual({ block: "probe Box", macro: "portrait", reason: "ungranted-image" });
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
		expect(plan.promptPlan.blocks.find((block) => block.kind === kind)?.content).toContain(`${formatImageReference("scene", owned.hash)} [Image: stray] [Image: portrait]`);
	}
	expect(plan.promptPlan.warnings).toEqual(expect.arrayContaining([
		{ block: "probe Box", macro: "stray", reason: "ungranted-image" },
		{ block: "probe Box", macro: "portrait", reason: "ungranted-image" },
	]));
	expect(plan.budget.tokenEstimate).toBe(1500);
});
