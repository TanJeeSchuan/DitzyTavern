import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { openInitializedDatabase } from "../database/database";
import { createCharacterLibraryModule, type CharacterLibraryCommand } from "../character-library";
import { base64, pngFixture } from "../image/image-fixtures";
import { createContract } from ".";

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };

describe("Image routes", () => {
	let database: Database;

	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => { database.close(); });

	const createCharacter = (body: Omit<Extract<CharacterLibraryCommand, { type: "create" }>, "type">) => createContract(database).handle(new Request("http://localhost/api/characters/commands", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "create", ...body }),
	}));

	test("serves a Portrait by hash with permanent caching", async () => {
		const original = pngFixture({ card: "chara-card" });
		const created = await createCharacter({
			definition: { name: "Maren", prompt, openings: [], portrait: { hash: "0".repeat(64), focalX: 0.5, focalY: 0.5 } },
			images: [base64(original)],
		});
		expect(created.status).toBe(422);

		const hash = createHash("sha256").update(pngFixture()).digest("hex");
		const stored = await createCharacter({
			definition: { name: "Maren", prompt, openings: [], portrait: { hash, focalX: 0.5, focalY: 0.5 } },
			images: [base64(original)],
		});
		expect(stored.status).toBe(200);

		const response = await createContract(database).handle(new Request(`http://localhost/api/images/${hash}`));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("cache-control")).toContain("immutable");
		expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), pngFixture())).toBe(0);
	});

	test("rejects unsupported uploads without creating anything", async () => {
		const response = await createCharacter({
			definition: { name: "Maren", prompt, openings: [] },
			images: [base64(Buffer.from("not an image"))],
		});
		expect(response.status).toBe(422);
		expect(createCharacterLibraryModule(database).list()).toEqual([]);
		expect(database.query("SELECT hash FROM image").all()).toEqual([]);
	});

	test("answers an unknown hash with not-found", async () => {
		const response = await createContract(database).handle(new Request(`http://localhost/api/images/${"a".repeat(64)}`));
		expect(response.status).toBe(404);
	});
});
