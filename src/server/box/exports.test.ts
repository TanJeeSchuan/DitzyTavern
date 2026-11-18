import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boxSdkVersion } from "../../shared/contract/box-descriptor";
import { createChat } from "../contract/prompt-preset-test-fixtures";
import { insertBox, openObservedDatabase, setBoxState } from "../test-fixtures/conversation";
import { builtInBoxes, loadBoxes } from "./registry";
import { boxExports } from "./exports";

const lantern = { sdk: boxSdkVersion, label: "Lantern", summary: "Hangs a lit lantern in the scene.", role: "system", startsEnabled: false, instructions: "" };
const pluginFolders: string[] = [];
afterEach(() => { for (const folder of pluginFolders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
// @approved
//  Each plugin declares one `greet` Export the tests drive through
// `boxExports`, resolving its TypeBox from the checkout as an installed
// plugin resolves its packages.
const typebox = JSON.stringify(Bun.resolveSync("@sinclair/typebox", import.meta.dir));
const descriptor = (name: string) => `import { Type } from ${typebox};
export default {
	...${JSON.stringify({ id: name, ...lantern })},
	exports: { greet: { description: "Greets one person.", input: Type.Object({ name: Type.String() }), output: Type.Object({ greeting: Type.String() }) } },
};`;
const installPlugins = (plugins: Record<string, string>) => {
	const root = mkdtempSync(join(tmpdir(), "ditzy-boxes-"));
	pluginFolders.push(root);
	for (const [name, server] of Object.entries(plugins)) {
		mkdirSync(join(root, name));
		writeFileSync(join(root, name, "shared-descriptor.ts"), descriptor(name));
		writeFileSync(join(root, name, "server.ts"), server);
	}
	return root;
};

test("a disabled or absent provider is missing from boxExports, and an enabled one answers through its wrapped Export", async () => {
	const plugins = installPlugins({ greeter: "export default { exports: { greet: ({ name }) => ({ greeting: `Hello, ${name}.` }) } };" });
	const database = openObservedDatabase();
	try {
		await loadBoxes([builtInBoxes, plugins]);
		const chat = createChat(database);
		expect(boxExports(database, chat.id).greeter).toBeUndefined();
		insertBox(database, chat.id, "greeter");
		const exports = boxExports(database, chat.id);
		expect(Object.keys(exports).sort()).toEqual(["greeter", "memory"]);
		expect(exports["author-note"]).toBeUndefined();
		const greet = exports.greeter?.greet;
		if (greet === undefined) throw new Error("The greeter Box's Export is missing.");
		expect(greet({ name: "Ann" })).toEqual({ greeting: "Hello, Ann." });
		setBoxState(database, chat.id, "greeter", "disabled");
		expect(boxExports(database, chat.id).greeter).toBeUndefined();
	} finally {
		database.close();
		await loadBoxes([builtInBoxes]);
	}
});

test("an Export's input and output are checked against its declared schemas, failing naming the Box, the Export and the path", async () => {
	const plugins = installPlugins({ crooked: "export default { exports: { greet: ({ name }) => ({ greeting: name.length }) } };" });
	const database = openObservedDatabase();
	try {
		await loadBoxes([builtInBoxes, plugins]);
		const chat = createChat(database);
		insertBox(database, chat.id, "crooked");
		const greet = boxExports(database, chat.id).crooked?.greet;
		if (greet === undefined) throw new Error("The crooked Box's Export is missing.");
		expect(() => greet(undefined)).toThrow("The crooked Box's greet Export input is invalid at /: Expected object.");
		expect(() => greet({ name: 3 })).toThrow("The crooked Box's greet Export input is invalid at /name: Expected string.");
		expect(() => greet({ name: "Ann" })).toThrow("The crooked Box's greet Export output is invalid at /greeting: Expected string.");
	} finally {
		database.close();
		await loadBoxes([builtInBoxes]);
	}
});
