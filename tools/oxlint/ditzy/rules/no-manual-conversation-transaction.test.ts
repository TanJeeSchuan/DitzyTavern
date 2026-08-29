import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noManualConversationTransactionRule } from "./no-manual-conversation-transaction.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	languageOptions: { parserOptions: { lang: "ts" } },
});

tester.run(
	"no-manual-conversation-transaction",
	noManualConversationTransactionRule,
	{
		valid: [
			{
				filename: "src/server/conversation/commands/rename.ts",
				code: "return runConversationTransaction(database, (db) => rename(db));",
			},
			{
				filename: "src/server/conversation/commands/transaction.ts",
				code: "return database.transaction(() => work()).immediate();",
			},
		],
		invalid: [
			{
				filename: "src/server/conversation/commands/new-command.ts",
				code: "return database.transaction(() => connectConversationDatabase(database)).immediate();",
				errors: [{ messageId: "manualTransaction" }],
			},
		],
	},
);
