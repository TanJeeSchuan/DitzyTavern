import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BoxExports } from "./contract";
import type { BoxValue } from "../../shared/contract/box-value";
import { serverBoxes } from "./registry";
import { readBoxLifecycles } from "./setup";

// @approved
//  Every Box enabled in this Chat that declares Exports, each wrapped by the
// loader to check its input and output against the Box's declared schemas and
// answering synchronously with this Chat bound. The loader hands this to each
// Box's `routes` as `exportsOf`, which is the only reach into another Box's
// state, as the Box system's rules state. A versioned Box is sandboxed, so
// it declares none, and the loaded catalog answers for every Box that does.
export const boxExports = (database: Database, conversationId: number): BoxExports => {
	const lifecycles = readBoxLifecycles(drizzle(database), conversationId);
	return Object.fromEntries([...serverBoxes()].flatMap(([id, { box }]) => {
		if (lifecycles[id]?.state !== "enabled" || box.exports === undefined) return [];
		return [[id, Object.fromEntries(Object.entries(box.exports).map(([name, exportOf]) => [name, (input?: BoxValue) => exportOf(input, { database, conversationId })]))]];
	}));
};
