import { defineRule } from "@oxlint/plugins";

import { repositoryPath } from "../../ditzy/path.ts";

const DEFAULT_MARKER = "==[HUMAN APPROVED]==";
const PREVIEW_LIMIT = 160;

interface Options {
	marker?: string;
	ignoreCommentPatterns?: string[];
	ignoreFilePatterns?: string[];
}

const defaultOptions = {
	marker: DEFAULT_MARKER,
	ignoreCommentPatterns: ["oxlint-disable", "eslint-disable", "^/\\s*<reference\\b"],
	ignoreFilePatterns: [],
} satisfies Options;

const singleLineValue = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

/** Audit rule: every comment must carry an explicit human-approval marker.
 *
 *  Line comments that stand alone on their line group into one logical
 *  block across adjacent lines and are reported once; a marker anywhere in
 *  the block approves the whole block. A line comment trailing code on its
 *  line is its own block and also breaks the surrounding runs, so an inline
 *  remark can never be approved as a side effect of its neighbors. */
export const noUnapprovedCommentsRule = defineRule({
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Require every comment block (standalone adjacent line comments count as one; trailing comments stand alone) to carry an explicit approval marker; unmarked blocks are audit findings.",
		},
		messages: {
			unapprovedComment:
				'Comment is not marked as human-approved ("{{preview}}"). Add "{{marker}}" to approve it, or trim/remove it.',
		},
		schema: [
			{
				type: "object",
				properties: {
					marker: { type: "string" },
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
				if (options.ignoreFilePatterns.some((pattern) => new RegExp(pattern).test(repositoryPath(context.filename)))) {
					return;
				}
				const commentPatterns = options.ignoreCommentPatterns.map((pattern) => new RegExp(pattern));
				const approved = (value: string): boolean => value.includes(options.marker);
				const ignored = (value: string): boolean => commentPatterns.some((pattern) => pattern.test(value));
				const sourceLines = context.sourceCode.text.split("\n");
				const standalone = (comment: { loc: { start: { line: number; column: number } } }): boolean =>
					(sourceLines[comment.loc.start.line - 1] ?? "").slice(0, comment.loc.start.column).trim() === "";
				const report = (node: unknown, preview: string): void => {
					context.report({
						node: node as never,
						messageId: "unapprovedComment",
						data: {
							marker: options.marker,
							preview: preview.length > PREVIEW_LIMIT ? `${preview.slice(0, PREVIEW_LIMIT)}…` : preview,
						},
					});
				};
				const comments = context.sourceCode.getAllComments();
				let index = 0;
				while (index < comments.length) {
					const comment = comments[index];
					index += 1;
					if (comment.type === "Shebang") continue;
					if (comment.type !== "Line" || !standalone(comment)) {
						if (!approved(comment.value) && !ignored(comment.value)) report(comment, singleLineValue(comment.value));
						continue;
					}
					// Consume the run of standalone line comments on adjacent lines.
					const block = [comment];
					while (
						index < comments.length &&
						comments[index].type === "Line" &&
						standalone(comments[index]) &&
						comments[index].loc.start.line === block[block.length - 1].loc.end.line + 1
					) {
						block.push(comments[index]);
						index += 1;
					}
					if (block.some((member) => approved(member.value) || ignored(member.value))) continue;
					report(block[0], singleLineValue(block.map((member) => member.value).join(" ")));
				}
			},
		};
	},
});
