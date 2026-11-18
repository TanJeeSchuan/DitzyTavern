import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BoxValue } from "../../shared/contract/box-value";
import { serverBoxes } from "./registry";
import { readBoxLifecycles } from "./setup";

/** @approved The Exports a route handler may call: one map per enabled Box that declares them, each Export taking its input and answering for one Chat. */
export type BoxExports = Readonly<Record<string, Readonly<Record<string, (input?: BoxValue) => BoxValue>>>>;

// @approved
//  Every Box enabled in this Chat that declares Exports, each wrapped by the
// loader to check its input and output against the Box's declared schemas and
// answering synchronously with this Chat bound. Only a route handler may call
// this; `advance`, a digest and a fold never may, since a Box's result there
// depends only on its own captured inputs, or a preview fingerprint would
// miss the change and a swipe would not reproduce the same outcome. A
// versioned Box is sandboxed, so it declares none, and the loaded catalog
// answers for every Box that does.
export const boxExports = (database: Database, conversationId: number): BoxExports => {
	const lifecycles = readBoxLifecycles(drizzle(database), conversationId);
	return Object.fromEntries([...serverBoxes()].flatMap(([id, { box }]) => {
		if (lifecycles[id]?.state !== "enabled" || box.exports === undefined) return [];
		return [[id, Object.fromEntries(Object.entries(box.exports).map(([name, exportOf]) => [name, (input?: BoxValue) => exportOf(input, { database, conversationId })]))]];
	}));
};
