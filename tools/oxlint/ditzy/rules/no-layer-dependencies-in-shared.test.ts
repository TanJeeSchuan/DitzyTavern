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
		{
			filename: "src/boxes/race/server.ts",
			code: "import type { Database } from 'bun:sqlite'; import { readBoxLifecycles } from '../../box-sdk/server';",
		},
	],
	invalid: [
		{
			filename: "src/boxes/race/contract.ts",
			code: "import type { Box } from '../../box-sdk/server';",
			errors: [{ messageId: "layerDependency" }],
		},
		{
			filename: "src/boxes/race/shared-data.ts",
			code: "import { raceBox } from './server-engine';",
			errors: [{ messageId: "layerDependency" }],
		},
		{
			filename: "src/boxes/race/shared.ts",
			code: "export * from './server-engine'; const engine = import('./server-engine');",
			errors: [{ messageId: "layerDependency" }, { messageId: "layerDependency" }],
		},
		{
			filename: "src/boxes/phone/shared.ts",
			code: "import { PhonePanel } from './client';",
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
