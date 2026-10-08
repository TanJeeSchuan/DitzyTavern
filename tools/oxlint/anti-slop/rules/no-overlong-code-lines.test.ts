import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";

import { noOverlongCodeLinesRule } from "./no-overlong-code-lines.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({
	languageOptions: { parserOptions: { lang: "tsx" } },
});

const longCodeArrow = "const apply = (current) => { setRevision(current.revision); setSaved(current.text); setBoth(current.previous); appliedFlag = true; pendingFlag = false; savedSnapshot = current.text; revisionSnapshot = current.revision; };";
const longTemplateInterior = "b".repeat(230);
const longStringBody = "a".repeat(220);
const longCommentBody = "c".repeat(220);
const longJsxProse = "word ".repeat(45).trimEnd();

tester.run("no-overlong-code-lines", noOverlongCodeLinesRule, {
	valid: [
		// Short code lines are untouched.
		"const x = 1;",
		// Every character of the interior template-literal line is string content.
		`const prompt = \`You are a Tavern Ferryman.\n${longTemplateInterior}\nEnd of prompt.\`;`,
		// A string may sit alone on its own line after breaking the statement.
		`const s =\n\t"${longStringBody}";`,
		// Interior JSX text reads as pure literal content.
		`<p>\n${longJsxProse}\n</p>;`,
		// Comment-only lines are exempt.
		`// ${longCommentBody}`,
		`/* ${longCommentBody} */`,
		// Emoji above must not desynchronize string coverage (byte vs code-unit offsets).
		`const icon = \`😀\n${longTemplateInterior}\`;`,
		// Custom ceiling below the default.
		{ code: "let q = 4;", options: [{ max: 12 }] },
	],
	invalid: [
		{
			// A long single string is not exempt: `const s = ` and `;` are code.
			code: `const s = "${longStringBody}";`,
			errors: [{ line: 1, messageId: "overlongCodeLine" }],
		},
		{
			// A long element line carries JSX attribute code outside the string.
			code: `<button className="${longStringBody}" />;`,
			errors: [{ line: 1, messageId: "overlongCodeLine" }],
		},
		{
			// Ternary chains: code, not literal text.
			code: `const value = cond ? "${longStringBody}" : "y";`,
			errors: [{ line: 1, messageId: "overlongCodeLine" }],
		},
		{
			// Same-line JSX text is mixed with tag code, unlike the Interior exemption.
			code: `<p>${longJsxProse}</p>;`,
			errors: [{ line: 1, messageId: "overlongCodeLine" }],
		},
		{
			// A substitution inside a multi-line template is code on that line.
			code: `const t = \`${longTemplateInterior}\${value}\`;`,
			errors: [{ line: 1, messageId: "overlongCodeLine" }],
		},
		{
			// Multi-statement arrow bodies: break the statements onto lines.
			code: longCodeArrow,
			errors: [{ line: 1, messageId: "overlongCodeLine" }],
		},
		{
			// The rendered message names the measured length and the ceiling.
			code: `const zzz = "${longStringBody}".slice(0, 5);`,
			errors: [{ message: /Line is \d+ characters; the ceiling is 200\. Break long code/ }],
		},
		{
			// Each offending line is reported separately.
			code: `${longCodeArrow}\nconst q = "${longStringBody}";`,
			errors: [{ line: 1, messageId: "overlongCodeLine" }, { line: 2, messageId: "overlongCodeLine" }],
		},
		{
			// Custom ceiling flags short lines too.
			code: "const ab = 1234;",
			options: [{ max: 14 }],
			errors: [{ line: 1, messageId: "overlongCodeLine" }],
		},
		{
			// An array of short string members is code: its only uncovered
			// characters are commas and brackets, which per-member run resets
			// would let escape. Structural counting flags it.
			code: `const names = [${Array.from({ length: 50 }, () => `"a"`).join(", ")}];`,
			errors: [{ line: 1, messageId: "overlongCodeLine" }],
		},
	],
});
