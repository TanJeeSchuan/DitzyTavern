import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import { noUnapprovedCommentsRule } from "./no-unapproved-comments.ts";

RuleTester.describe = describe;
RuleTester.it = it;
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });
const unapproved = { messageId: "unapprovedComment" };
const obsolete = { messageId: "obsoleteApprovalMarker" };

tester.run("no-unapproved-comments", noUnapprovedCommentsRule, {
	valid: [
		"const x = 1;",
		"// oxlint-disable-next-line no-explicit-any",
		"// eslint-disable-next-line no-console",
		'/// <reference types="vite/client" />',
		"// @approved",
		"// @approved\n// lead\n// middle\n// tail",
		"// oxlint-disable-next-line no-console\n// prose follows the directive",
		"/* @approved keep this comment */",
		"/** @approved\n * keep\n * this\n */",
		"/**\n * @approved keep this comment\n */",
		"const a = 1; // @approved trailing note",
		"const a = 1; /* @approved trailing block */",
		{ code: "// plain comment\nconst x = 1;", filename: "src/shared/contract/wire.ts", options: [{ ignoreFilePatterns: ["^src/shared/contract/"] }] },
	],
	invalid: [
		{ code: "// plain comment", errors: [{ line: 1, column: 0, ...unapproved }] },
		{ code: "/* wall\n * of\n * text */\nconst x = 1;", errors: [{ line: 1, ...unapproved }] },
		{ code: "// prose\nconst x = 1;", errors: [{ message: /not marked as human-approved.*Put "@approved" first/ }] },
		{ code: "// one\nconst x = 1;\n// two", errors: [{ line: 1, ...unapproved }, { line: 3, ...unapproved }] },
		{ code: "// lead\n// middle\n// tail", errors: [{ line: 1, ...unapproved }] },
		{ code: "// @approved\n// intro\nconst x = 1; // trailing note", errors: [{ line: 3, ...unapproved }] },
		{ code: "const x = 1; // @approved note\n// unmarked prose", errors: [{ line: 2, ...unapproved }] },
		{ code: "// a\n\n// b", errors: [{ line: 1, ...unapproved }, { line: 3, ...unapproved }] },
		{ code: "// @approved\n\n// prose", errors: [{ line: 3, ...unapproved }] },
		{ code: "// lead prose\n// @approved", errors: [{ line: 1, ...unapproved }] },
		{ code: "// @approved\nconst x = 1; // trailing note", errors: [{ line: 2, ...unapproved }] },
		{ code: "// @approved\n/* doc */", errors: [{ line: 2, ...unapproved }] },
		{ code: "// @approved and here is why", errors: [unapproved] },
		{ code: "const x = 1; // note @approved", errors: [unapproved] },
		{ code: "/* prose @approved */", errors: [unapproved] },
		{ code: "/* @approvedly prose */", errors: [unapproved] },
		{ code: "// ==[HUMAN APPROVED]== keep this comment", errors: [obsolete, unapproved] },
		{ code: "/* ==[HUMAN APPROVED]== keep this comment */", errors: [obsolete, unapproved] },
		{ code: "const a = 1; // trailing ==[HUMAN APPROVED]==", errors: [obsolete, unapproved] },
		{ code: "// @approved\n// ==[HUMAN APPROVED]== prose", errors: [obsolete] },
		{ code: "// ==[HUMAN APPROVED]== prose", filename: "src/shared/contract/wire.ts", options: [{ ignoreFilePatterns: ["^src/shared/contract/"] }], errors: [obsolete] },
	],
});
