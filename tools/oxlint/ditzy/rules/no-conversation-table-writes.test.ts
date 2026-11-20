import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import { noConversationTableWritesRule } from "./no-conversation-table-writes.ts";

RuleTester.describe = describe;
RuleTester.it = it;
const outside = "src/server/workflows/example.ts";
const selection = 'import { conversationPromptPresetTable } from "../database/schema"; ';

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
	"no-conversation-table-writes",
	noConversationTableWritesRule,
	{
		valid: [
			{ filename: outside, code: selection + "db.select().from(conversationPromptPresetTable);" },
			{ filename: outside, code: selection + "const f = (conversationPromptPresetTable) => db.update(conversationPromptPresetTable);" },
			{ filename: outside, code: 'import { characterTable } from "../database/schema"; db.insert(characterTable);' },
			{ filename: "src/server/conversation/commands/paint.ts", code: selection + "db.update(conversationPromptPresetTable);" },
			{ filename: "src/server/workflows/example.test.ts", code: selection + "db.update(conversationPromptPresetTable);" },
			{ filename: "src/server/prompt-preset/recipe.ts", code: selection + "db.insert(conversationPromptPresetTable);" },
		],
		invalid: [
			{ filename: outside, code: selection + "db.update(conversationPromptPresetTable).set({ paint_preset_id: id });", errors: [{ messageId: "directWrite" }] },
			{ filename: outside, code: 'import { participantDataTable as data } from "@/server/database/schema"; tx.insert(data);', errors: [{ messageId: "directWrite" }] },
			{ filename: outside, code: 'import * as schema from "../database/schema.ts"; db["delete"](schema.artifactTable);', errors: [{ messageId: "directWrite" }] },
			{ filename: "src/server/prompt-preset/recipe.ts", code: 'import { conversationTable } from "../database/schema"; db.delete(conversationTable);', errors: [{ messageId: "directWrite" }] },
		],
	},
);
