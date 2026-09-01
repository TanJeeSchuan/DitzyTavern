import { defineRule } from "@oxlint/plugins";

import { repositoryPath } from "../../ditzy/path.ts";

const DEFAULT_MARKER = "==[HUMAN APPROVED]==";

interface Options {
	marker?: string;
	ignoreCommentPatterns?: string[];
	ignoreFilePatterns?: string[];
}

const defaultOptions = {
	marker: DEFAULT_MARKER,
	ignoreCommentPatterns: ["oxlint-disable", "eslint-disable"],
	ignoreFilePatterns: [],
} satisfies Options;

const singleLineValue = (value: string): string => value.replaceAll(/\s+/g, " ").trim();

/** Audit rule: every comment must carry an explicit human-approval marker. */
export const noUnapprovedCommentsRule = defineRule({
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Require every comment to carry an explicit approval marker; unmarked comments are audit findings.",
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
				for (const comment of context.sourceCode.getAllComments()) {
					if (comment.type === "Shebang") continue;
					if (comment.value.includes(options.marker)) continue;
					if (commentPatterns.some((pattern) => pattern.test(comment.value))) continue;
					context.report({
						node: comment,
						messageId: "unapprovedComment",
						data: { marker: options.marker, preview: singleLineValue(comment.value) },
					});
				}
			},
		};
	},
});