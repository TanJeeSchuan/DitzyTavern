import { defineRule } from "@oxlint/plugins";

import { repositoryPath } from "../../ditzy/path.ts";

const APPROVED_DIRECTIVE = "@approved";
const PREVIEW_LIMIT = 160;

interface Options {
	ignoreCommentPatterns?: string[];
	ignoreFilePatterns?: string[];
}

const defaultOptions = {
	ignoreCommentPatterns: ["oxlint-disable", "eslint-disable", "^/\\s*<reference\\b", "^\\s*@vite-ignore\\s*$"],
	ignoreFilePatterns: [],
} satisfies Options;

const singleLineValue = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

/** Audit rule: each comment block carries @approved. Standalone line-comment
 * runs use an exact leading directive; block and trailing comments put the
 * directive first in their own text. Approval never crosses code or a gap. */
export const noUnapprovedCommentsRule = defineRule({
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Require every comment block (standalone adjacent line comments count as one; trailing comments stand alone) to carry an explicit approval marker; unmarked blocks are audit findings.",
		},
		messages: {
			obsoleteApprovalMarker: "Inline approval markers are obsolete. Use @approved at the start of the comment block.",
			unapprovedComment:
				'Comment is not marked as human-approved ("{{preview}}"). Put "@approved" first in the comment block, or trim/remove it.',
		},
		schema: [
			{
				type: "object",
				properties: {
					ignoreCommentPatterns: { type: "array", items: { type: "string" } },
					ignoreFilePatterns: { type: "array", items: { type: "string" } },
				},
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
				const options = { ...defaultOptions, ...provided };
				const commentPatterns = options.ignoreCommentPatterns.map((pattern) => new RegExp(pattern));
				const approved = (value: string): boolean => /^[\s*]*@approved(?:\s|$)/.test(value);
				const approvedDirective = (value: string): boolean => value.trim() === APPROVED_DIRECTIVE;
				const ignored = (value: string): boolean => commentPatterns.some((pattern) => pattern.test(value));
				const sourceLines = context.sourceCode.text.split("\n");
				const standalone = (comment: { loc: { start: { line: number; column: number } } }): boolean =>
					(sourceLines[comment.loc.start.line - 1] ?? "").slice(0, comment.loc.start.column).trim() === "";
				const report = (node: unknown, preview: string): void => {
					context.report({
						node: node as never,
						messageId: "unapprovedComment",
						data: {
							preview: preview.length > PREVIEW_LIMIT ? `${preview.slice(0, PREVIEW_LIMIT)}…` : preview,
						},
					});
				};
				const comments = context.sourceCode.getAllComments();
				for (const comment of comments) {
					if (/==\[HUMAN\sAPPROVED\]==/.test(comment.value)) context.report({ node: comment, messageId: "obsoleteApprovalMarker" });
				}
				if (options.ignoreFilePatterns.some((pattern) => new RegExp(pattern).test(repositoryPath(context.filename)))) {
					return;
				}
				type Comment = (typeof comments)[number];
				const standaloneLine = (comment: Comment): boolean => comment.type === "Line" && standalone(comment);
				const continues = (previous: Comment, next: Comment): boolean =>
					standaloneLine(previous) && standaloneLine(next) && next.loc.start.line === previous.loc.end.line + 1;
				for (const [index, comment] of comments.entries()) {
					if (comment.type === "Shebang") continue;
					if (!standaloneLine(comment)) {
						if (!approved(comment.value) && !ignored(comment.value)) report(comment, singleLineValue(comment.value));
						continue;
					}
					const previous = comments[index - 1];
					if (previous !== undefined && continues(previous, comment)) continue;
					// Each run of standalone line comments on adjacent lines is judged once, from its first comment.
					const block = [comment];
					let last = comment;
					for (let next = comments[index + 1], at = index + 1; next !== undefined && continues(last, next); next = comments[++at]) {
						block.push(next);
						last = next;
					}
					// A standalone directive must be exact and first in its run.
					if (approvedDirective(comment.value) || block.some((member) => ignored(member.value))) continue;
					report(comment, singleLineValue(block.map((member) => member.value).join(" ")));
				}
			},
		};
	},
});
