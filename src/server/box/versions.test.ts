import { afterEach, expect, test } from "bun:test";
import { readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { writeBoxFiles, writeVersionedBox } from "../test-fixtures/versioned-box";
import { discoverBoxes, unversionedBoxIds } from "./registry";
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

// @approved
//  A version's own walk checks only inside that version, so a `versions/`
// that links elsewhere would let an unpacked plugin make the loader read and
// build outside its folder.
test("a versioned Box whose versions/ is a link is refused before anything in it is read", async () => {
	const box = await writeVersionedBox("jar", [files]);
	try {
		const outside = join(box.plugins, "..", "outside");
		renameSync(join(box.home, "versions"), outside);
		symlinkSync(join(process.cwd(), outside), join(box.home, "versions"));
		const { boxes, refused } = await discoverBoxes([box.plugins]);
		expect(boxes.map(({ descriptor }) => descriptor.id)).toEqual([]);
		expect(refused.map(({ reason }) => reason)).toEqual([expect.stringContaining("versions/ is not a plain folder")]);
	} finally {
		box.remove();
	}
});
