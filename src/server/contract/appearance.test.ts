import { expect, test } from "bun:test";
import { createConversation } from "../conversation";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { emptyPromptChannels } from "../../shared/definition";
import { createConversationRoutes } from "./conversation";
import { createPromptPresetRoutes } from "./prompt-preset-routes";
import { importPreset, appliedId, readOperation, addBlock, readStoredRecipe, captureModelFetch, completeGeneration, key, startGeneration, withProfile } from "./prompt-preset-test-fixtures";
import { uploadImage } from "../image";
import { pngFixture } from "../image/image-fixtures";
import { formatImageReference } from "../../shared/image-reference";
import { createCharacterLibraryModule } from "../character-library";
import { createNativeConversation, saveParticipantAsCharacter } from "../workflows";
import { readConversationSummary } from "../conversation";

test("the Default preset sends each Appearance immediately after its Identity", async () => {
	using database = openObservedDatabase();
	const chat = createConversation(database, {
		name: "Appearance",
		participants: [
			{ definition: { name: "Writer", sendAppearanceImages: true, prompt: { ...emptyPromptChannels(), identity: "Writer Identity", appearance: "Writer Appearance" }, openings: [] } },
			{ definition: { name: "Maren", sendAppearanceImages: true, prompt: { ...emptyPromptChannels(), identity: "Maren Identity", appearance: "Maren Appearance" }, openings: [] } },
		], control: { human: 0, model: 1 },
	});
	withProfile(database);
	let captured: unknown;
	const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch((request) => { captured = request; }) });
	const generationId = await startGeneration(app, chat.id, chat.revision);
	await completeGeneration(app, chat.id, generationId);
	expect(captured).toMatchObject({ messages: [
		{ role: "user", content: "Writer Identity" },
		{ role: "user", content: "Writer Appearance" },
		{ role: "assistant", content: "Maren Identity" },
		{ role: "assistant", content: "Maren Appearance" },
		{ role: "user", content: "Set the scene." },
	] });
});

for (const sendAppearanceImages of [true, false]) {
	test(`Appearance Images are ${sendAppearanceImages ? "sent" : "anchors"} while the Portrait stays out of the request`, async () => {
		using database = openObservedDatabase();
		const bytes = pngFixture({ width: 10 });
		const picture = await uploadImage(database, bytes);
		const portrait = await uploadImage(database, pngFixture({ width: 11 }));
		const chat = createConversation(database, {
			name: "Appearance Images", participants: [
				{ definition: { name: "Writer", prompt: emptyPromptChannels(), sendAppearanceImages: true, openings: [] } },
				{ definition: { name: "Maren", prompt: { ...emptyPromptChannels(), identity: "Maren Identity", appearance: `Grey eyes. ${formatImageReference("Maren", picture.hash)}` }, sendAppearanceImages, portrait: { hash: portrait.hash, focalX: 0.5, focalY: 0.5 }, openings: [] } },
			], control: { human: 0, model: 1 },
		});
		withProfile(database);
		let captured: unknown;
		const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch((request) => { captured = request; }) });
		const id = await startGeneration(app, chat.id, chat.revision);
		await completeGeneration(app, chat.id, id);
		expect(captured).toMatchObject({ messages: [
			{ role: "assistant", content: "Maren Identity" },
			{ role: "assistant", content: "Grey eyes. [Image: Maren]" },
			...(sendAppearanceImages ? [{ role: "user", content: [
				{ type: "text", text: "[Image: Maren]" },
				{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` } },
			] }] : []),
			{ role: "user", content: "Set the scene." },
		] });
	});
}

test("empty Appearance adds no message to the existing request", async () => {
	using database = openObservedDatabase();
	const definition = { name: "Writer", prompt: { ...emptyPromptChannels(), identity: "Identity" }, sendAppearanceImages: true, openings: [] };
	const chat = createConversation(database, { name: "Empty Appearance", participants: [{ definition }, { definition: { ...definition, name: "Maren" } }], control: { human: 0, model: 1 } });
	withProfile(database);
	let captured: unknown;
	const app = createConversationRoutes(database, { masterKey: key, fetch: captureModelFetch((request) => { captured = request; }) });
	const id = await startGeneration(app, chat.id, chat.revision);
	await completeGeneration(app, chat.id, id);
	expect(captured).toMatchObject({ messages: [
		{ role: "user", content: "Identity" }, { role: "assistant", content: "Identity" }, { role: "user", content: "Set the scene." },
	] });
});

test("a Participant keeps its Appearance and switch after its source Character changes, including Save as Character", () => {
	using database = openObservedDatabase();
	const library = createCharacterLibraryModule(database);
	const definition = { name: "Maren", prompt: { ...emptyPromptChannels(), appearance: "Grey eyes and a navy coat." }, sendAppearanceImages: false, openings: [] };
	const source = library.execute({ type: "create", definition });
	const chat = createNativeConversation(database, {
		name: "Independent Appearance",
		humanSeat: { type: "adhoc", definition: { ...definition, name: "Writer" } },
		modelSeat: { type: "character", characterId: source.id, expectedRevision: source.revision },
	});
	library.execute({ type: "update-definition", characterId: source.id, expectedRevision: source.revision, definition: {
		...definition, sendAppearanceImages: true, prompt: { ...definition.prompt, appearance: "Green eyes and a red coat." },
	} });
	const participant = readConversationSummary(database, chat.id)!.cast[1]!;
	expect(participant).toMatchObject({ prompt: { appearance: "Grey eyes and a navy coat." }, sendAppearanceImages: false });
	const saved = saveParticipantAsCharacter(database, { conversationId: chat.id, expectedConversationRevision: chat.revision, participantId: participant.id });
	expect(saved.character).toMatchObject({ prompt: { appearance: "Grey eyes and a navy coat." }, sendAppearanceImages: false });
});

for (const owner of ["human", "model"] as const) {
	for (const withIdentity of [true, false]) {
		test(`${owner} Appearance starts with ${withIdentity ? "the first matching Identity's current role" : "the Identity reference's default role when absent"}`, async () => {
			using database = openObservedDatabase();
			const routes = createPromptPresetRoutes(database);
			const imported = await importPreset(routes, { name: "Appearance roles", slots: withIdentity ? [
				{ reference: `${owner}-identity`, enabled: true, role: "system" },
				{ reference: `${owner}-identity`, enabled: true, role: "user" },
			] : [] });
			const presetId = appliedId(imported);
			await readOperation(addBlock(database, presetId, `${owner}-appearance`));
			const appearance = readStoredRecipe(database, presetId).slots.find((slot) => slot.reference === `${owner}-appearance`);
			expect(appearance).toMatchObject({ role: withIdentity ? "system" : owner === "human" ? "user" : "assistant" });
		});
	}
}
