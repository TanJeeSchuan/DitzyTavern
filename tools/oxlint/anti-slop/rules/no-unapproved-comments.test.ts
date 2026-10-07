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
		// Triple-slash reference directives are directives, not prose.
		"/// <reference types=\"vite/client\" />",
		// Adjacent line comments form one block; a marker anywhere in the
		// block approves the whole block.
		"// ==[HUMAN APPROVED]== lead\n// middle\n// tail",
		"// lead\n// middle\n// tail ==[HUMAN APPROVED]==",
		// The `// @approved` directive line: the second spelling of the one
		// approval mechanism, as the first line of a standalone block.
		"// @approved\n// prose the directive approves",
		"// @approved\n// lead\n// middle\n// tail",
		// The directive spelling is fixed and independent of the marker option.
		{
			code: "// @approved\n// note",
			options: [{ marker: "[APPROVED]" }],
		},
		// The directive line is itself an approved comment; the prose it
		// approves follows it in the same block.
		"// @approved",
		// A directive line inside a run blesses its block.
		"// oxlint-disable-next-line no-console\n// prose follows the directive",
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
			// Rendered message includes the comment preview and both approval
			// spellings.
			code: "// prose\nconst x = 1;",
			errors: [{ message: /not marked as human-approved \("prose"\)\. Add "==\[HUMAN APPROVED\]==" inline, or put "\/\/ @approved" first in a standalone line-comment block/ }],
		},
		{
			code: "// one\nconst x = 1;\n// two",
			errors: [{ line: 1, messageId: "unapprovedComment" }, { line: 3, messageId: "unapprovedComment" }],
		},
		{
			// An unmarked standalone run is ONE finding anchored at its first line.
			code: "// lead\n// middle\n// tail\nconst x = 1;",
			errors: [{ line: 1, messageId: "unapprovedComment" }],
		},
		{
			// A trailing comment is its own block even next to an approved run.
			code: "// ==[HUMAN APPROVED]== intro\nconst x = 1; // trailing note",
			errors: [{ line: 2, messageId: "unapprovedComment" }],
		},
		{
			// A standalone comment after a trailing one starts a new block.
			code: "const x = 1; // note\n// unmarked prose",
			errors: [{ line: 1, messageId: "unapprovedComment" }, { line: 2, messageId: "unapprovedComment" }],
		},
		{
			// A blank line splits two blocks; each is reported.
			code: "// a\n\n// b",
			errors: [{ line: 1, messageId: "unapprovedComment" }, { line: 3, messageId: "unapprovedComment" }],
		},
		{
			// Marker-like text without the exact delimiters does not count.
			code: "// =HUMAN APPROVED=",
			errors: [{ messageId: "unapprovedComment" }],
		},
		{
			// The directive must IMMEDIATELY precede its comment: a blank line
			// breaks the block, so the prose is unapproved.
			code: "// @approved\n\n// prose",
			errors: [{ line: 3, messageId: "unapprovedComment" }],
		},
		{
			// The directive is not leading; mid-block it approves nothing and
			// the whole run is reported.
			code: "// lead prose\n// @approved",
			errors: [{ line: 1, messageId: "unapprovedComment" }],
		},
		{
			// `@approved` above code approves nothing — the trailing comment on
			// the next line still needs the inline marker (mirrors the
			// trailing-comment block test above with the marker spelling).
			code: "// @approved\nconst x = 1; // trailing note",
			errors: [{ line: 2, messageId: "unapprovedComment" }],
		},
		{
			// The directive spelling only blesses standalone line-comment
			// blocks; a block comment still carries the inline marker.
			code: "// @approved\n/* doc */",
			errors: [{ line: 2, messageId: "unapprovedComment" }],
		},
		{
			// The directive must be the entire line — trailing words make it
			// prose (mirrors the marker delimiter test).
			code: "// @approved and here is why",
			errors: [{ messageId: "unapprovedComment" }],
		},
	],
});