import { expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { openObservedDatabase } from "../test-fixtures/conversation";
import { createDescribeRoutes } from "./describe";
import { createModelSelectionRoutes } from "./model-selection";
import { createConnectionSettingsModule } from "../connection-settings";
import { applyDescribingModelSettings, readDescribingModelSettings } from "../painting/describing-model-settings";
import { readImageModelSettings } from "../painting/image-model-settings";
import { uploadImage } from "../image";
import { pngFixture } from "../image/image-fixtures";
import { appearanceImageHashes, emptyPromptChannels } from "../../shared/definition";
import { formatImageReference } from "../../shared/image-reference";
import { description } from "../../shared/contract/describe";
import { captureModelFetch, key, profile } from "./prompt-preset-test-fixtures";

for (const useAppearance of [true, false]) {
	test(`Describe sends ${useAppearance ? "each distinct Appearance picture once in first-Reference order" : "the Portrait when Appearance has no pictures"} and the Ask`, async () => {
		using database = openObservedDatabase();
		const connections = createConnectionSettingsModule(database, { masterKey: key });
		connections.createProfile({ expectedRevision: 0, profile, credential: "describe-secret" });
		const profileId = connections.get().profiles[0]!.id;
		applyDescribingModelSettings(database, { type: "apply", expectedRevision: 0, profileId, model: "describing-model" });
		const bytes = [pngFixture({ width: 10 }), pngFixture({ width: 11 }), pngFixture({ width: 12 })];
		const pictures = await Promise.all(bytes.map((bytes) => uploadImage(database, bytes)));
		const definition = {
			prompt: { ...emptyPromptChannels(), appearance: useAppearance ? `Existing description. ${formatImageReference("Face", pictures[0]!.hash)} ${formatImageReference("Clothing", pictures[1]!.hash)} Again ${formatImageReference("Face again", pictures[0]!.hash)}` : "Existing description." },
			portrait: { hash: pictures[2]!.hash, focalX: 0.5, focalY: 0.5 },
		};
		let captured: unknown;
		const app = createDescribeRoutes(database, { masterKey: key, fetch: captureModelFetch((request) => { captured = request; }) });
		const response = await app.handle(new Request("http://localhost/api/describe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hashes: appearanceImageHashes(definition), ask: "Focus on clothing." }) }));
		expect(response.status).toBe(200);
		expect(Value.Decode(description, await response.json())).toEqual({ text: "Done." });
		expect(captured).toMatchObject({ model: "describing-model", messages: [
			{ role: "system", content: "Describe the character's face, hair, eyes, build, clothing and distinguishing marks. Describe only their appearance, nothing about personality." },
			{ role: "user", content: useAppearance ? [
				{ type: "text", text: "[Image: Picture 1]" },
				{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(bytes[0]!).toString("base64")}` } },
				{ type: "text", text: "\n\n[Image: Picture 2]" },
				{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(bytes[1]!).toString("base64")}` } },
				{ type: "text", text: "\n\nFocus on clothing." },
			] : [
				{ type: "text", text: "[Image: Picture 1]" },
				{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(bytes[2]!).toString("base64")}` } },
				{ type: "text", text: "\n\nFocus on clothing." },
			] },
		] });
		if (useAppearance) {
			const firstPictureOccurrences = JSON.stringify(captured).split(`data:image/png;base64,${Buffer.from(bytes[0]!).toString("base64")}`).length - 1;
			expect(firstPictureOccurrences).toBe(1);
		}
	});
}

test("a Text-only describing model refuses Describe without sending a provider request", async () => {
	using database = openObservedDatabase();
	const connections = createConnectionSettingsModule(database, { masterKey: key });
	connections.createProfile({ expectedRevision: 0, profile, credential: "describe-secret" });
	const profileId = connections.get().profiles[0]!.id;
	connections.setTextOnlyModel({ profileId, modelId: "text-only", textOnly: true });
	applyDescribingModelSettings(database, { type: "apply", expectedRevision: 0, profileId, model: "text-only" });
	const picture = await uploadImage(database, pngFixture({ width: 10 }));
	const captured: unknown[] = [];
	const app = createDescribeRoutes(database, { masterKey: key, fetch: captureModelFetch((request) => captured.push(request)) });
	const response = await app.handle(new Request("http://localhost/api/describe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hashes: [picture.hash] }) }));
	expect(response.status).toBe(422);
	expect(await response.json()).toEqual({ outcome: "invalid", reason: "Choose a describing model that accepts Images" });
	expect(captured).toEqual([]);
});

test("the app-wide describing model selection is revisioned independently of the Image Model", async () => {
	using database = openObservedDatabase();
	const connections = createConnectionSettingsModule(database, { masterKey: key });
	connections.createProfile({ expectedRevision: 0, profile, credential: "describe-secret" });
	const profileId = connections.get().profiles[0]!.id;
	const app = createModelSelectionRoutes(database);
	const save = (expectedRevision: number) => app.handle(new Request("http://localhost/api/describing-model/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "apply", expectedRevision, profileId, model: "describing-model" }) }));
	expect((await save(0)).status).toBe(200);
	expect(readDescribingModelSettings(database)).toEqual({ revision: 1, profileId, model: "describing-model" });
	expect((await save(0)).status).toBe(409);
	expect(readImageModelSettings(database)).toEqual({ revision: 0, profileId: null, model: "" });
});

test("Describe sends only the chosen hashes when the Ask contains an Image Reference", async () => {
	using database = openObservedDatabase();
	const connections = createConnectionSettingsModule(database, { masterKey: key });
	connections.createProfile({ expectedRevision: 0, profile, credential: "describe-secret" });
	applyDescribingModelSettings(database, { type: "apply", expectedRevision: 0, profileId: connections.get().profiles[0]!.id, model: "describing-model" });
	const chosenBytes = pngFixture({ width: 20 });
	const chosen = await uploadImage(database, chosenBytes);
	const other = await uploadImage(database, pngFixture({ width: 21 }));
	let captured: unknown;
	const app = createDescribeRoutes(database, { masterKey: key, fetch: captureModelFetch((request) => { captured = request; }) });
	const response = await app.handle(new Request("http://localhost/api/describe", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hashes: [chosen.hash], ask: `Describe the coat. ${formatImageReference("Other", other.hash)}` }),
	}));
	expect(response.status).toBe(200);
	expect(captured).toMatchObject({ messages: [
		{ role: "system", content: "Describe the character's face, hair, eyes, build, clothing and distinguishing marks. Describe only their appearance, nothing about personality." },
		{ role: "user", content: [
			{ type: "text", text: "[Image: Picture 1]" },
			{ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(chosenBytes).toString("base64")}` } },
			{ type: "text", text: "\n\nDescribe the coat. [Image: Other]" },
		] },
	] });
});
