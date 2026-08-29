import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noLayerDependenciesInSharedRule } from "./no-layer-dependencies-in-shared.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	languageOptions: { parserOptions: { lang: "ts" } },
});

tester.run("no-layer-dependencies-in-shared", noLayerDependenciesInSharedRule, {
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
			errors: [{ messageId: "layerDependency" }],
		},
		{
			filename: "src/shared/conversation.ts",
			code: "import type { ConversationSnapshot } from '../server/conversation';",
			errors: [{ messageId: "layerDependency" }],
		},
		{
			filename: "src/shared/value.ts",
			code: "import type { Database } from 'bun:sqlite';",
			errors: [{ messageId: "layerDependency" }],
		},
	],
});
