import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import { noTypeAliasRenameRule } from "./no-type-alias-rename.ts";

RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } }).run(
	"no-type-alias-rename",
	noTypeAliasRenameRule,
	{
		valid: [
			"type Id = Brand<string>;",
			"type Row = Schema.Row;",
			"export { read };",
			{ filename: "src/box-sdk/client.ts", code: 'export type { Portrait as PortraitImage } from "./image";' },
		],
		invalid: [
			{ code: "type Accepted = AcceptedGenerationRecord;", errors: [{ messageId: "typeRename" }] },
			{ code: "export { read as load };", errors: [{ messageId: "exportRename" }] },
			{ code: 'export type { Row as RecordRow } from "./schema";', errors: [{ messageId: "exportRename" }] },
		],
	},
);
