import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { sandboxedDescriptorFile } from "../../shared/contract/box-sandboxed";
import { BOX_PACKAGES, pinnedPackages } from "./sandboxed-deps";
import { sandboxedFolder } from "./sandboxed-folder";

test("a dependency names a package at one exact x.y.z version, and every other npm specifier fails the check", () => {
	const accepts = (dependencies: Record<string, string>) => Value.Check(sandboxedDescriptorFile.properties.dependencies, dependencies);
	const refused = [
		"^0.170.0", "~0.170.0", ">=0.170.0", "0.170.0 || 0.171.0", "0.170", "0.170.x", "*", "", "latest", "next", "v0.170.0", "00.170.0", " 0.170.0", "0.170.0-beta.1",
		"npm:three@0.170.0", "file:../three", "link:../three", "workspace:*", "git+ssh://git@github.com/mrdoob/three.js.git", "github:mrdoob/three.js", "mrdoob/three.js#r170", "https://example.com/three.tgz",
	];
	expect(refused.filter((version) => accepts({ three: version }))).toEqual([]);
	expect(["@/box-sdk", "../three", "Three", "@scope/../x", "node:fs"].filter((name) => accepts({ [name]: "1.0.0" }))).toEqual([]);
	expect([accepts({ three: "0.170.0" }), accepts({ "@types/three": "0.170.0" })]).toEqual([true, true]);
});

// A fake esm.sh: each package URL answers with the stub the real one serves, re-exporting a bundle on the same origin.
const modules = new Map(Object.entries({
	"/dice@1.0.0?bundle&target=es2022": '/* esm.sh - dice@1.0.0 */\nexport * from "/dice@1.0.0/es2022/dice.bundle.mjs";\nexport { default } from "/dice@1.0.0/es2022/dice.bundle.mjs";\n',
	"/dice@1.0.0/es2022/dice.bundle.mjs": "/* esm.sh - dice@1.0.0 */\nvar roll=(n)=>n%6+1;export{roll as default};\n",
	"/jwt@9.0.2?bundle&target=es2022": '/* esm.sh - jwt@9.0.2 */\nimport "/node/crypto.mjs";\nexport * from "/jwt@9.0.2/es2022/jwt.bundle.mjs";\n',
	"/chained@1.0.0?bundle&target=es2022": 'export * from "/chained@1.0.0/es2022/chained.bundle.mjs";\n',
	"/chained@1.0.0/es2022/chained.bundle.mjs": 'import { helper } from "/helper@1.0.0/es2022/helper.mjs";\nexport const value = helper;\n',
	"/elsewhere@1.0.0?bundle&target=es2022": 'export * from "https://cdn.example.com/elsewhere.mjs";\n',
}));
const requests: string[] = [];
// @approved
//  `/endless@1.0.0` streams 64 KiB chunks forever, so a fetch that buffered
// the whole response before checking its size would never return, and its
// `cancel` records that the reader stopped it.
const endless = { cancelled: false };
const server = Bun.serve({ port: 0, fetch: (request) => {
	const url = new URL(request.url);
	const path = url.pathname + url.search;
	requests.push(path);
	if (path === "/endless@1.0.0?bundle&target=es2022") return new Response(new ReadableStream({
		pull: (controller) => {
			controller.enqueue(new TextEncoder().encode(`/*${"x".repeat(64 * 1024 - 4)}*/`));
		},
		cancel: () => { endless.cancelled = true; },
	}));
	const body = modules.get(path);
	return body === undefined ? new Response("Not found", { status: 404 }) : new Response(body, { headers: { "content-type": "application/javascript" } });
} });
const origin = server.url.origin;
afterAll(() => server.stop(true));

const folders: string[] = [];
const folder = () => {
	const made = mkdtempSync(join(tmpdir(), "ditzy-deps-"));
	folders.push(made);
	return made;
};
/** @approved Pins against the folder as the loader would: its snapshot first. */
const pin = async (box: string, dependencies: Record<string, string>, from = origin) => await pinnedPackages(box, "dice-box", await sandboxedFolder(box, "dice-box"), dependencies, from);
afterEach(() => {
	for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
	requests.length = 0;
});

test("a package is fetched once through esm.sh's stub to its import-free bundle, pinned in deps.lock.json, and then loads offline", async () => {
	const box = folder();
	const pinned = await pin(box, { dice: "1.0.0" });
	const bundle = modules.get("/dice@1.0.0/es2022/dice.bundle.mjs");
	expect(pinned.get("dice")).toBe(bundle);
	expect(readFileSync(join(box, "deps", "dice@1.0.0.js"), "utf8")).toBe(bundle!);
	expect(JSON.parse(readFileSync(join(box, "deps.lock.json"), "utf8"))).toEqual({ "dice@1.0.0": new Bun.CryptoHasher("sha256").update(bundle!).digest("hex") });
	expect(requests).toEqual(["/dice@1.0.0?bundle&target=es2022", "/dice@1.0.0/es2022/dice.bundle.mjs"]);
	requests.length = 0;
	expect((await pin(box, { dice: "1.0.0" }, "http://127.0.0.1:9")).get("dice")).toBe(bundle);
	expect(requests).toEqual([]);
});

test("a tampered deps/ file fails its hash, and a fetch that differs from the lock is refused too", async () => {
	const box = folder();
	await pin(box, { dice: "1.0.0" });
	writeFileSync(join(box, "deps", "dice@1.0.0.js"), "export default () => 6;");
	await expect(pin(box, { dice: "1.0.0" })).rejects.toThrow("The dice-box Box's dependency dice@1.0.0 does not match its hash in deps.lock.json.");
	rmSync(join(box, "deps"), { recursive: true });
	writeFileSync(join(box, "deps.lock.json"), JSON.stringify({ "dice@1.0.0": "0".repeat(64) }));
	await expect(pin(box, { dice: "1.0.0" })).rejects.toThrow("The dice-box Box's dependency dice@1.0.0 does not match its hash in deps.lock.json.");
});

test("a package that does not end in one import-free module on esm.sh's origin is refused, naming the Box and the package", async () => {
	const refused = async (name: string) => await pin(folder(), { [name]: name === "jwt" ? "9.0.2" : "1.0.0" }).then(() => "pinned", (error: Error) => error.message);
	expect(await refused("jwt")).toBe("The dice-box Box's dependency jwt@9.0.2 imports /node/crypto.mjs; a package must bundle into one module with no imports.");
	expect(await refused("chained")).toBe("The dice-box Box's dependency chained@1.0.0 imports /helper@1.0.0/es2022/helper.mjs; a package must bundle into one module with no imports.");
	expect(await refused("elsewhere")).toBe("The dice-box Box's dependency elsewhere@1.0.0 imports https://cdn.example.com/elsewhere.mjs; a package must bundle into one module with no imports.");
	expect(await refused("missing")).toBe(`The dice-box Box's dependency missing@1.0.0 could not be fetched: ${origin}/missing@1.0.0?bundle&target=es2022 answered 404.`);
});

test("a response over the package cap is cancelled as it streams, not read to its end", async () => {
	await expect(pin(folder(), { endless: "1.0.0" })).rejects.toThrow("The dice-box Box's dependency endless@1.0.0 is over 4 MiB.");
	for (let waited = 0; waited < 40 && !endless.cancelled; waited++) await Bun.sleep(50);
	expect(endless.cancelled).toBe(true);
});

test("a Box's packages stay within their count before any fetch, and within their total size whether shipped or fetched", async () => {
	const many = Object.fromEntries(Array.from({ length: BOX_PACKAGES + 1 }, (_, index) => [`unused-${index}`, "1.0.0"]));
	await expect(pin(folder(), many)).rejects.toThrow(`The dice-box Box declares ${BOX_PACKAGES + 1} dependencies; a sandboxed Box may declare at most ${BOX_PACKAGES}.`);
	expect(requests).toEqual([]);

	const box = folder();
	mkdirSync(join(box, "deps"));
	const shipped = `export default ${JSON.stringify("x".repeat(3 * 1024 * 1024))};`;
	const hash = new Bun.CryptoHasher("sha256").update(shipped).digest("hex");
	for (const name of ["a", "b", "c"]) writeFileSync(join(box, "deps", `${name}@1.0.0.js`), shipped);
	writeFileSync(join(box, "deps.lock.json"), JSON.stringify({ "a@1.0.0": hash, "b@1.0.0": hash, "c@1.0.0": hash }));
	await expect(pin(box, { a: "1.0.0", b: "1.0.0", c: "1.0.0" })).rejects.toThrow("The dice-box Box's dependency c@1.0.0 takes the Box's packages over 8 MiB.");
	expect(requests).toEqual([]);
});

