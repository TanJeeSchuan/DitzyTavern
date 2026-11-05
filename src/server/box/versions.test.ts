import { afterEach, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeBoxFiles } from "../test-fixtures/versioned-box";
import { unversionedBoxIds } from "./registry";
import { createVersion, listVersions, versionFolder } from "./versions";

const root = join(".scratch", `versions-${crypto.randomUUID()}`);
afterEach(() => rmSync(root, { recursive: true, force: true }));

const descriptor = JSON.stringify({ id: "jar", sdk: 2, label: "Jar", summary: "Holds coins.", role: "system", startsEnabled: false, instructions: "", window: { icon: "coins", size: { width: 10, height: 10 } } });
const files = { "descriptor.json": descriptor, "logic.js": "export default { read: () => ({ view: null }) };", "ui.js": "host.render('');" };
const create = async (name: string, contents: Readonly<Record<string, string>>) => {
	writeBoxFiles(join(root, name), contents);
	const { version, checked } = await createVersion(join(root, "plugins", "jar"), join(root, name), "jar", unversionedBoxIds());
	checked.dispose();
	return version;
};

test("identical sources make one version, and creating it again leaves it alone", async () => {
	const first = await create("a", files);
	const marker = Bun.file(join(versionFolder(join(root, "plugins", "jar"), first), "logic.js"));
	const written = (await marker.stat()).mtimeMs;
	expect(await create("b", files)).toBe(first);
	expect([await listVersions(join(root, "plugins", "jar")), (await marker.stat()).mtimeMs]).toEqual([[first], written]);
	expect(readdirSync(join(root, "plugins", "jar", "versions")).filter((name) => name.startsWith("."))).toEqual([]);
});

test("a changed deps.lock.json makes a new version, though no package changed", async () => {
	const first = await create("a", { ...files, "deps.lock.json": "{}\n" });
	const second = await create("b", { ...files, "deps.lock.json": "{ }\n" });
	expect(second).not.toBe(first);
	expect(await listVersions(join(root, "plugins", "jar"))).toEqual([first, second].sort());
});
