import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openInitializedDatabase } from "../database/database";
import { uploadImage } from "../image";
import { pngFixture } from "../image/image-fixtures";
import { createConversationWithHistory, insertBox } from "../test-fixtures/conversation";
import { BOX_IMAGE_BYTES, BOX_IMAGE_COUNT, boxFrameImage, closeBoxFrame, openBoxFrame, uploadBoxFrameImage } from "./frame";

const definition = (name: string, hash?: string) => ({
	name, prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [],
	...hash !== undefined && { portrait: { hash, focalX: 0.5, focalY: 0.5 } },
});
const frameIn = (database: Database) => {
	const chat = createConversationWithHistory(database, { name: "Here", participants: [{ definition: definition("Ann") }] });
	const instance = insertBox(database, chat.id, "race");
	return { chat, instance, token: openBoxFrame({ box: "race", conversationId: chat.id, instance, version: undefined }) };
};

// @approved
//  A frame shows an Image only when the host says its Box owns it: a Portrait
// of its own Chat's Cast, or an upload it made through a frame. Another
// Chat's Portrait and an Image nobody granted it answer nothing, and no
// answer may be cached past a later check.
test("a frame serves its own Chat's Cast Portraits and its Box's uploads, uncached, and no other Image", async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const [own, elsewhere, stray] = await Promise.all([1, 2, 3].map(async (width) => (await uploadImage(database, pngFixture({ width }))).hash));
	const chat = createConversationWithHistory(database, { name: "Here", participants: [{ definition: definition("Ann", own) }, { definition: definition("Bo") }] });
	createConversationWithHistory(database, { name: "There", participants: [{ definition: definition("Cy", elsewhere) }] });
	const token = openBoxFrame({ box: "race", conversationId: chat.id, instance: insertBox(database, chat.id, "race"), version: undefined });
	const served = (hash: string | undefined) => boxFrameImage(database, token, hash!)?.status;

	expect([served(own), served(elsewhere), served(stray)]).toEqual([200, undefined, undefined]);
	expect(boxFrameImage(database, token, own!)?.headers.get("cache-control")).toBe("no-store");
	const uploaded = await uploadBoxFrameImage(database, token, pngFixture({ width: 4 }));
	expect(served(uploaded?.hash)).toBe(200);
	database.close();
});

// @approved
//  A token answers only for the frame and the Box instance it was opened
// for: closing the frame ends it, and so does removing the Box, even once
// the Box is inserted again.
test("a frame token stops answering once its frame closes, or once its Box is removed and inserted again", async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const granted = (token: string) => uploadBoxFrameImage(database, token, pngFixture({ width: 5 }));
	const closed = frameIn(database);
	expect(await granted(closed.token)).toBeDefined();
	closeBoxFrame(closed.token);
	expect(await granted(closed.token)).toBeUndefined();

	const { chat, token } = frameIn(database);
	const { hash } = (await granted(token))!;
	database.query("DELETE FROM conversation_data WHERE conversation_id = ? AND namespace = 'box:race'").run(chat.id);
	insertBox(database, chat.id, "race");
	expect(boxFrameImage(database, token, hash)).toBeUndefined();
	expect(await granted(token)).toBeUndefined();
	database.close();
});

// @approved
//  Uploads count against the Box, not the frame: past its Image count or its
// byte total, an upload is refused before it is stored.
test.each([
	["count", BOX_IMAGE_COUNT, 1],
	["byte total", 1, BOX_IMAGE_BYTES],
] as const)("a Box past its upload %s is refused", async (_, images, size) => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const { token } = frameIn(database);
	for (let index = 0; index < images; index++) {
		const hash = index.toString(16).padStart(64, "0");
		database.query("INSERT INTO image (hash, bytes, media_type, byte_size, width, height) VALUES (?, x'00', 'image/png', ?, 1, 1)").run(hash, size);
		database.query("INSERT INTO box_image_grant (box_id, hash) VALUES ('race', ?)").run(hash);
	}
	const stored = database.query("SELECT count(*) AS images FROM image").get();
	await expect(uploadBoxFrameImage(database, token, pngFixture({ width: 6 }))).rejects.toThrow("The race Box already holds its 200 images or 100 MiB of uploads.");
	expect(database.query("SELECT count(*) AS images FROM image").get()).toEqual(stored);
	database.close();
});

test("concurrent uploads from two of a Box's frames cannot both pass its quota, and a frame closed mid-upload stores nothing", async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const [first, second] = [frameIn(database), frameIn(database)];
	for (let index = 0; index < BOX_IMAGE_COUNT - 1; index++) {
		const hash = index.toString(16).padStart(64, "0");
		database.query("INSERT INTO image (hash, bytes, media_type, byte_size, width, height) VALUES (?, x'00', 'image/png', 1, 1, 1)").run(hash);
		database.query("INSERT INTO box_image_grant (box_id, hash) VALUES ('race', ?)").run(hash);
	}
	const results = await Promise.allSettled([uploadBoxFrameImage(database, first.token, pngFixture({ width: 7 })), uploadBoxFrameImage(database, second.token, pngFixture({ width: 8 }))]);
	expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
	expect(database.query("SELECT count(*) AS grants FROM box_image_grant WHERE box_id = 'race'").get()).toEqual({ grants: BOX_IMAGE_COUNT });
	const third = frameIn(database);
	database.query("DELETE FROM box_image_grant").run();
	const stored = database.query("SELECT count(*) AS images FROM image").get();
	const upload = uploadBoxFrameImage(database, third.token, pngFixture({ width: 9 }));
	closeBoxFrame(third.token);
	expect(await upload).toBeUndefined();
	expect(database.query("SELECT count(*) AS images FROM image").get()).toEqual(stored);
	database.close();
});
