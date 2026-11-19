import type { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BoxExports } from "./contract";
import type { BoxValue } from "../../shared/contract/box-value";
import { serverBoxes } from "./registry";
import { readBoxLifecycles } from "./setup";

const withoutPrototype = <T extends object>(dictionary: T): T => {
	Object.setPrototypeOf(dictionary, null);
	return dictionary;
};

// @approved
//  Every Box enabled in this Chat that declares Exports, each wrapped by the
// loader to check its input and output against the Box's declared schemas and
// answering synchronously with this Chat bound, and carrying the description
// and schemas its descriptor declares, so a caller can tell an agent what
// each one takes and answers. The loader hands this to each
// Box's `routes` as `exportsOf`, which is the only reach into another Box's
// state, as the Box system's rules state. A versioned Box is sandboxed, so
// it declares none, and the loaded catalog answers for every Box that does.
export const boxExports = (database: Database, conversationId: number): BoxExports => {
	const lifecycles = readBoxLifecycles(drizzle(database), conversationId);
	return withoutPrototype(Object.fromEntries([...serverBoxes()].flatMap(([id, { box, descriptor }]) => {
		if (lifecycles[id]?.state !== "enabled" || box.exports === undefined || descriptor.exports === undefined) return [];
		const declared = descriptor.exports;
		const byName = Object.fromEntries(Object.entries(box.exports).flatMap(([name, exportOf]) => {
			const declaration = declared[name];
			return declaration === undefined ? [] : [[name, Object.assign((input?: BoxValue) => exportOf(input, { database, conversationId }), declaration)]];
		}));
		return [[id, withoutPrototype(byName)]];
	})));
};
