import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import { noConversationInternalImportsRule } from "./no-conversation-internal-imports.ts";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
tester.run("no-conversation-internal-imports", noConversationInternalImportsRule, {
 valid: [
  { filename: "src/server/memory/recall.ts", code: 'import { readSelectedHistory } from "../conversation";' },
  { filename: "src/server/conversation/history.ts", code: 'import { messageTable } from "../database/schema";' },
  { filename: "src/server/conversation/commands/edit.ts", code: 'import { findConversation } from "../internal";' },
  { filename: "src/server/memory/recall.test.ts", code: 'import { messageTable } from "../database/schema";' },
  { filename: "src/server/database/schema.ts", code: 'import { messageTable } from "./schema";' },
 ],
 invalid: [
  { filename: "src/server/database/schema.ts", code: 'import type { ConversationSummary } from "../conversation/types";', errors: [{ messageId: "internalImport" }] },
  { filename: "src/server/memory/recall.ts", code: 'import { readChatHistory } from "../conversation/history";', errors: [{ messageId: "internalImport" }] },
  { filename: "src/server/workflows/nested/capture.ts", code: 'import type { ConversationSummary } from "../../conversation/types";', errors: [{ messageId: "internalImport" }] },
  { filename: "src/server/memory/recall.ts", code: 'import { messageVariantTable as variants } from "../database/schema";', errors: [{ messageId: "tableImport" }] },
  { filename: "src/server/workflows/recovery.ts", code: 'import * as schema from "../database/schema";', errors: [{ messageId: "tableImport" }] },
 ],
});
