import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noServerRuntimeImportsInClientRule } from "./no-server-runtime-imports-in-client.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	languageOptions: { parserOptions: { lang: "ts" } },
});

tester.run(
	"no-server-runtime-imports-in-client",
	noServerRuntimeImportsInClientRule,
	{
		valid: [
			{
				filename: "src/client/lib/eden.ts",
				code: "import type { Contract } from '../../server/contract';",
			},
			{
				filename: "src/client/conversation.ts",
				code: "import { type ConversationAction } from '../../server/conversation';",
			},
			{
				filename: "src/client/lib/eden.ts",
				code: "import { treaty } from '@elysiajs/eden';",
			},
			{
				filename: "src/client/chat-history.ts",
				code: "import { chatHistoryPage } from '../shared/contract/conversation-schema';",
			},
			{
				// Tests mount server adapters directly against temporary stores.
				filename: "src/client/import-chat.test.ts",
				code: "import { createChatImportRoutes } from '../server/contract';",
			},
			{
				filename: "src/server/index.ts",
				code: "import { contract } from './contract';",
			},
		],
		invalid: [
			{
				filename: "src/client/conversation.ts",
				code: "import { createConversationModule } from '../server/conversation';",
				errors: [{ messageId: "serverRuntimeDependency" }],
			},
			{
				filename: "src/client/conversation.ts",
				code: "import { type ConversationAction, createConversationModule } from '../../server/conversation';",
				errors: [{ messageId: "serverRuntimeDependency" }],
			},
			{
				filename: "src/client/conversation.ts",
				code: "import type { Stale } from '../server/conversation'; import { openDatabase } from '../server/database/database';",
				errors: [{ messageId: "serverRuntimeDependency" }],
			},
		],
	},
);
