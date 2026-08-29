import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noRuntimeImportsInSharedRule } from "./no-runtime-imports-in-shared.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	languageOptions: { parserOptions: { lang: "ts" } },
});

tester.run("no-runtime-imports-in-shared", noRuntimeImportsInSharedRule, {
	valid: [
		{
			filename: "src/shared/contract/settings.ts",
			code: "import { Type } from '@sinclair/typebox'; export const settings = Type.Object({});",
		},
		{
			filename: "src/server/http/settings.ts",
			code: "import { settings } from '../../shared/contract/settings';",
		},
	],
	invalid: [
		{
			filename: "src/shared/contract/new-route.ts",
			code: "import { createConversationModule } from '../../server/conversation';",
			errors: [{ messageId: "runtimeDependency" }],
		},
		{
			filename: "src/shared/value.ts",
			code: "import type { Database } from 'bun:sqlite';",
			errors: [{ messageId: "runtimeDependency" }],
		},
	],
});
