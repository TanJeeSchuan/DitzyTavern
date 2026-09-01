import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noUnapprovedCommentsRule } from "./no-unapproved-comments.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	languageOptions: { parserOptions: { lang: "ts" } },
});

tester.run("no-unapproved-comments", noUnapprovedCommentsRule, {
	valid: [
		// Marker present, any position.
		"// ==[HUMAN APPROVED]== keep this comment",
		"/* ==[HUMAN APPROVED]==\n * keep\n * this\n */",
		"const a = 1; // trailing ==[HUMAN APPROVED]==",
		// No comments at all.
		"const x = 1;",
		// Directive-like comments are ignored by default.
		"// oxlint-disable-next-line no-explicit-any",
		"// eslint-disable-next-line no-console",
		// Custom marker via options.
		{
			code: "// [APPROVED] note",
			options: [{ marker: "[APPROVED]" }],
		},
		// ignoreFilePatterns opt the file out entirely.
		{
			code: "// plain comment\nconst x = 1;",
			filename: "src/shared/contract/wire.ts",
			options: [{ ignoreFilePatterns: ["^src/shared/contract/"] }],
		},
	],
	invalid: [
		{
			code: "// plain comment",
			errors: [{ line: 1, column: 0, messageId: "unapprovedComment" }],
		},
		{
			code: "/* wall\n * of\n * text */\nconst x = 1;",
			errors: [{ line: 1, messageId: "unapprovedComment" }],
		},
		{
			// Rendered message includes the comment preview and the marker.
			code: "// prose\nconst x = 1;",
			errors: [{ message: /not marked as human-approved \("prose"\)\. Add "==\[HUMAN APPROVED\]=="/ }],
		},
		{
			code: "// one\nconst x = 1;\n// two",
			errors: [{ line: 1, messageId: "unapprovedComment" }, { line: 3, messageId: "unapprovedComment" }],
		},
		{
			// Marker-like text without the exact delimiters does not count.
			code: "// =HUMAN APPROVED=",
			errors: [{ messageId: "unapprovedComment" }],
		},
	],
});