import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { openInitializedDatabase } from "../database/database";
import { sweepOrphanedImages } from "../image";
import { pngFixture } from "../image/image-fixtures";
import { createContract } from ".";

const prompt = { systemInstruction: "", identity: "", scenario: "", exampleDialogue: "", postHistoryInstruction: "" };

describe("Image routes", () => {
	let database: Database;
	beforeEach(() => { database = openInitializedDatabase({ path: ":memory:" }); });
	afterEach(() => { database.close(); });

	const upload = (bytes: Uint8Array) => createContract(database).handle(new Request("http://localhost/api/images", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: Buffer.from(bytes).toString("base64") }),
	}));
	const createPortrait = (hash: string) => createContract(database).handle(new Request("http://localhost/api/characters/commands", {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "create", definition: { name: "Maren", prompt, openings: [], portrait: { hash, focalX: 0.5, focalY: 0.5 } } }),
	}));

	test("uploads metadata-stripped bytes once and serves them by hash with permanent caching", async () => {
		const original = pngFixture({ card: "chara-card" });
		const response = await upload(original);
		expect(response.status).toBe(200);
		const hash = createHash("sha256").update(pngFixture()).digest("hex");
		expect(await response.json()).toEqual({ hash });
		expect(await (await upload(original)).json()).toEqual({ hash });
		expect(database.query("SELECT hash, orphaned_at FROM image").all()).toEqual([{ hash, orphaned_at: expect.any(Number) }]);
		database.query("UPDATE image SET orphaned_at = 0 WHERE hash = ?").run(hash);
		const reuploadedAt = Date.now();
		expect((await upload(original)).status).toBe(200);
		expect(database.query<{ orphaned_at: number }, []>("SELECT orphaned_at FROM image").get()?.orphaned_at).toBeGreaterThanOrEqual(reuploadedAt);
		const created = await createPortrait(hash);
		expect(created.status).toBe(200);
		sweepOrphanedImages(database);
		expect((await upload(original)).status).toBe(200);
		expect(database.query("SELECT orphaned_at FROM image").get()).toEqual({ orphaned_at: null });

		const served = await createContract(database).handle(new Request(`http://localhost/api/images/${hash}`));
		expect(served.status).toBe(200);
		expect(served.headers.get("content-type")).toBe("image/png");
		expect(served.headers.get("cache-control")).toContain("immutable");
		expect(Buffer.compare(Buffer.from(await served.arrayBuffer()), pngFixture())).toBe(0);
	});

	test("rejects unsupported uploads with the ingest reason and no stored Image", async () => {
		const response = await upload(Buffer.from("not an image"));
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ outcome: "invalid", reason: "Only PNG, JPEG, WebP, and GIF images are accepted." });
		expect(database.query("SELECT hash FROM image").all()).toEqual([]);
	});

	test("rejects oversized uploads without storing them", async () => {
		const response = await upload(new Uint8Array(20 * 1024 * 1024 + 1));
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ outcome: "invalid", reason: "Images may be at most 20 MB." });
		expect(database.query("SELECT hash FROM image").all()).toEqual([]);
	});

	test("rejects an unknown Portrait hash with the shared image error", async () => {
		const response = await createPortrait("a".repeat(64));
		expect(response.status).toBe(422);
		expect(await response.json()).toEqual({ outcome: "invalid", reason: "The Portrait image is missing." });
		expect(database.query("SELECT id FROM character").all()).toEqual([]);
	});

	test("answers an unknown hash with not-found", async () => {
		const response = await createContract(database).handle(new Request(`http://localhost/api/images/${"a".repeat(64)}`));
		expect(response.status).toBe(404);
	});
});
