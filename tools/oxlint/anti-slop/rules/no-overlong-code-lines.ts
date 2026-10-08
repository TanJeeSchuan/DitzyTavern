import { defineRule } from "@oxlint/plugins";

import type { SourceCode } from "@oxlint/plugins";

const DEFAULT_MAX = 200;
const MAX_INLINE_CODE_DEBRIS = 3;

interface Options {
	max?: number;
}

const LITERAL_OR_COMMENT_TYPES = new Set(["String", "Template", "JSXText", "Line", "Block", "Shebang"]);

const isWhitespace = (value: string): boolean => /\s/u.test(value);

/** Mark each character offset hidden inside a string/template/JSX-text token or a comment. */
const markLiteralFields = (source: SourceCode): Uint8Array => {
	const covered = new Uint8Array(source.text.length);
	for (const tokenOrComment of source.tokensAndComments) {
		if (!LITERAL_OR_COMMENT_TYPES.has(tokenOrComment.type)) continue;
		for (let offset = tokenOrComment.start; offset < tokenOrComment.end; offset += 1) covered[offset] = 1;
	}
	return covered;
};

/** Uncovered, non-whitespace code characters on one line, counted ACROSS string
 * tokens: resetting at each literal would let arrays of short string members
 * (commas and brackets are the only code) escape the ceiling entirely. */
// A line carrying several literal tokens is not "one big literal": arrays of
// short string members are code even though every run between them is a
// comma. A single literal (or template, or JSX text) stays exempt.
const inlineLiteralCount = (line: string, covered: Uint8Array, lineStart: number, source: SourceCode): number => {
	let count = 0;
	for (const tokenOrComment of source.tokensAndComments) {
		if (!LITERAL_OR_COMMENT_TYPES.has(tokenOrComment.type)) continue;
		if (tokenOrComment.end <= lineStart || tokenOrComment.start >= lineStart + line.length) continue;
		if (tokenOrComment.type === "Line" || tokenOrComment.type === "Block" || tokenOrComment.type === "Shebang") continue;
		count += 1;
	}
	return count;
};
const longestCodeRun = (line: string, covered: Uint8Array, lineStart: number): number => {
	let longest = 0;
	let run = 0;
	for (let column = 0; column < line.length; column += 1) {
		if (covered[lineStart + column] === 1) {
			run = 0;
			continue;
		}
		if (isWhitespace(line[column])) continue;
		run += 1;
		longest = Math.max(longest, run);
	}
	return longest;
};

/** Enforce a length ceiling on code lines; prompt-template lines, long URL constants, and JSX prose that read as pure string-literal content stay exempt. */
export const noOverlongCodeLinesRule = defineRule({
	meta: {
		type: "layout",
		docs: {
			description:
				"Flag source lines over the length ceiling whose length comes from code. A line dominated by string-literal content (template chunks, string tokens, JSX text) or comments — a prompt template body, a long URL constant — is exempt even when a closing delimiter or semicolon trails it; structural code is counted across literals, so arrays of short string members are still code. A warning, so pre-existing offenders are burned down rather than failing CI.",
		},
		messages: {
			overlongCodeLine:
				"Line is {{length}} characters; the ceiling is {{max}}. Break long code onto statements or lines (JSX props, ternaries, object literals). A line whose length is entirely string-literal or comment content is exempt.",
		},
		schema: [
			{
				type: "object",
				properties: { max: { type: "integer", minimum: 1 } },
				additionalProperties: false,
			},
		],
	},
	createOnce(context) {
		return {
			"Program:exit"() {
				// `context.options` is only populated per file, right before the
				// visitor runs — reading it at createOnce scope captures null.
				const provided = (context.options?.[0] ?? {}) as Partial<Options>;
				const max = provided.max ?? DEFAULT_MAX;
				const source = context.sourceCode;
				const covered = markLiteralFields(source);
				for (const [lineIndex, line] of source.getLines().entries()) {
					if (line.length <= max) continue;
					const lineStart = source.lineStartIndices[lineIndex];
					if (longestCodeRun(line, covered, lineStart) > MAX_INLINE_CODE_DEBRIS || inlineLiteralCount(line, covered, lineStart, source) > 2) {
						context.report({
							loc: { line: lineIndex + 1, column: 0 },
							messageId: "overlongCodeLine",
							data: { length: line.length, max },
						});
					}
				}
			},
		};
	},
});
