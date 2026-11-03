import { expect, test } from "bun:test";
import { openInitializedDatabase } from "../database/database";
import { uploadImage } from "../image";
import { pngFixture } from "../image/image-fixtures";
import { createConversationWithHistory, insertBox } from "../test-fixtures/conversation";
import { boxFrameImage, openBoxFrame, uploadBoxFrameImage } from "./frame";

// @approved
//  A frame shows an Image only when the host says its Box owns it: a Portrait
// of its own Chat's Cast, or an upload it made through a frame. Another
// Chat's Portrait and an Image nobody granted it answer nothing.
test("a frame serves its own Chat's Cast Portraits and its Box's uploads, and no other Image", async () => {
	const database = openInitializedDatabase({ path: ":memory:" });
	const [own, elsewhere, stray] = await Promise.all([1, 2, 3].map(async (width) => (await uploadImage(database, pngFixture({ width }))).hash));
	const definition = (name: string, hash: string) => ({ name, prompt: { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" }, openings: [], portrait: { hash, focalX: 0.5, focalY: 0.5 } });
	const chat = createConversationWithHistory(database, { name: "Here", participants: [{ definition: definition("Ann", own!) }, { definition: { ...definition("Bo", own!), portrait: undefined } }] });
	createConversationWithHistory(database, { name: "There", participants: [{ definition: definition("Cy", elsewhere!) }] });
	insertBox(database, chat.id, "race");
	const token = openBoxFrame({ box: "race", conversationId: chat.id });
	const served = (hash: string | undefined) => boxFrameImage(database, token, hash!)?.status;

	expect([served(own), served(elsewhere), served(stray)]).toEqual([200, undefined, undefined]);
	const uploaded = await uploadBoxFrameImage(database, token, pngFixture({ width: 4 }));
	expect(served(uploaded?.hash)).toBe(200);
	database.close();
});
