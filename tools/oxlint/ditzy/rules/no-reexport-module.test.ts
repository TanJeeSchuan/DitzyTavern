import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import { noReexportModuleRule } from "./no-reexport-module.ts";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
	"no-reexport-module",
	noReexportModuleRule,
	{
		valid: [
			{ filename: "src/server/conversation/index.ts", code: 'export * from "./history";' },
			{ filename: "/repo/src/box-sdk/server.ts", code: 'export * from "./api";' },
			{ filename: "src/shared/wire.ts", code: 'export type { Row } from "./schema"; export const version = 1;' },
			{ filename: "src/shared/wire.ts", code: "// A file with no statements is not a barrel." },
		],
		invalid: [
			{ filename: "src/shared/wire.ts", code: 'export * from "./api"; export type { Row } from "./schema";', errors: [{ messageId: "barrel" }] },
		],
	},
);
