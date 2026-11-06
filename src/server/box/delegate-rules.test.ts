import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { BoxValue } from "../../shared/contract/box-value";
import { builtInBoxes, discoverBoxes } from "./registry";

const scene = join(import.meta.dir, "../../../e2e/fixtures/boxes/scene");
/** @approved The Scene fixture's descriptor.json, as far as these tests rewrite it. */
type Delegate = { readonly tag: string; readonly summary: string; readonly description: string; readonly off: string; readonly operations: { readonly [key: string]: BoxValue | undefined } };
type Json = { readonly [key: string]: BoxValue | Delegate | undefined };
const descriptor: Json & { readonly delegate: Delegate } = JSON.parse(readFileSync(join(scene, "descriptor.json"), "utf8"));
const logic = readFileSync(join(scene, "logic.js"), "utf8");
const { delegate } = descriptor;
const { operations } = delegate;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// @approved
//  Each folder is the Scene fixture under its own id and tag, with `fields`
// written over its descriptor and `rewrite` applied to its logic.
const delegatingBoxes = (boxes: Record<string, { readonly fields?: Json; readonly rewrite?: (logic: string) => string }>) => {
	const root = mkdtempSync(join(tmpdir(), "ditzy-delegates-"));
	roots.push(root);
	for (const [id, { fields = {}, rewrite = (text: string) => text }] of Object.entries(boxes)) {
		mkdirSync(join(root, id));
		writeFileSync(join(root, id, "descriptor.json"), JSON.stringify({ ...descriptor, id, delegate: { ...delegate, tag: id }, ...fields }));
		writeFileSync(join(root, id, "logic.js"), rewrite(logic));
		writeFileSync(join(root, id, "ui.js"), readFileSync(join(scene, "ui.js"), "utf8"));
	}
	return root;
};

test("a delegating Box must keep records, read its own window and always render, may not digest, and its operations are a bounded array", async () => {
	const root = delegatingBoxes({
		scene: {},
		unrecorded: { fields: { record: undefined }, rewrite: (text) => text.replace("records: { initial: [], fold: (_, { props }) => props },", "") },
		unread: { rewrite: (text) => text.replace(/\tread: .*\n/, "") },
		unrendered: { fields: { alwaysRender: undefined } },
		unapplied: { rewrite: (text) => text.replace(/\tdelegate: .*\n/, "") },
		unbounded: { fields: { delegate: { ...delegate, operations: { ...operations, maxItems: undefined } } } },
		listed: { fields: { delegate: { ...delegate, operations: { type: "string" } } } },
		digesting: {
			fields: { decision: { summary: "", description: "", off: "", context: "" }, window: { kind: "digest", icon: "map", size: { width: 18, height: 12 } } },
			rewrite: (text) => text.replace("records: {", "records: { digest: { window: 0, run: () => ({ props: [] }) },").replace(/\tread: .*\n/, ""),
		},
	});
	const { boxes, refused } = await discoverBoxes([root]);
	for (const { dispose } of boxes) dispose?.();
	expect(boxes.map(({ descriptor: { id } }) => id)).toEqual(["scene"]);
	expect(refused.map(({ folder, reason }) => [basename(folder), reason])).toEqual([
		["digesting", "The digesting Box must declare a read, since it delegates; no decision, since it delegates."],
		["listed", "Its delegate's operations must be an array schema with maxItems."],
		["unapplied", "The unapplied Box must declare delegate.apply exactly when it declares a delegate."],
		["unbounded", "Its delegate's operations must be an array schema with maxItems."],
		["unread", "The unread Box must declare a read, since it delegates."],
		["unrecorded", "The unrecorded Box must declare a record, since it delegates."],
		["unrendered", "The unrendered Box must declare alwaysRender, since it delegates."],
	]);
});

test("a delegate tag another loaded Box takes for a delegate or a lens is refused", async () => {
	const root = delegatingBoxes({ scene: {}, "scene-again": { fields: { delegate: { ...delegate, tag: "scene" } } }, texting: { fields: { delegate: { ...delegate, tag: "sms" } } } });
	const { boxes, refused } = await discoverBoxes([builtInBoxes, root]);
	for (const { dispose } of boxes) dispose?.();
	expect(boxes.some(({ descriptor: { id } }) => id === "scene")).toBe(true);
	expect(refused.map(({ folder, reason }) => [basename(folder), reason])).toEqual([
		["scene-again", "Its tag scene is already the scene Box's."],
		["texting", "Its tag sms is already the phone Box's."],
	]);
});

test("delegate.apply's record is checked against the record schema, its throw keeps its message, and advance may never return a record", async () => {
	const root = delegatingBoxes({
		scene: {},
		recording: { rewrite: (text) => text.replace("({ items: state.length", "({ record: { props: state }, items: state.length") },
		overfull: { rewrite: (text) => text.replace("({ props: operations.reduce(apply, state) })", "({ props: operations.length })") },
	});
	const { boxes } = await discoverBoxes([root]);
	try {
		const box = (id: string) => boxes.find(({ descriptor }) => descriptor.id === id)!.box; // @approved Each fixture loads.
		const input = { setup: undefined, state: ["lantern"], cast: [] };
		expect(await box("scene").delegate?.apply({ ...input, operations: [{ kind: "place", prop: "table" }] })).toEqual({ props: ["lantern", "table"] });
		await expect(box("scene").delegate?.apply({ ...input, operations: [{ kind: "place", prop: "lantern" }] })).rejects.toThrow("The scene Box's delegate.apply threw Error: The lantern is already on stage.");
		await expect(box("overfull").delegate?.apply({ ...input, operations: [] })).rejects.toThrow("The overfull Box's delegate.apply result is invalid");
		// SAFETY: the Scene's advance reads no context.
		const context = undefined as never;
		await expect(box("recording").advance?.run({ setup: undefined, dependencies: undefined, state: ["lantern"], moves: [] }, context)).rejects.toThrow("The recording Box's advance.run result is invalid at /record");
	} finally {
		for (const { dispose } of boxes) dispose?.();
	}
});
