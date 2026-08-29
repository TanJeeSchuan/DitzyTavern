import { defineRule, type ESTree } from "@oxlint/plugins";

import { isTestFile, repositoryPath } from "../path.ts";

const isManualTransaction = (node: ESTree.CallExpression): boolean =>
	node.callee.type === "MemberExpression" &&
	!node.callee.computed &&
	node.callee.property.type === "Identifier" &&
	node.callee.property.name === "transaction";

/** Require Conversation writes to use the canonical immediate transaction seam. */
export const noManualConversationTransactionRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Route Conversation writes through runConversationTransaction.",
		},
		messages: {
			manualTransaction:
				"Conversation writes must use runConversationTransaction so immediate-mode setup and database connection wiring keep one owner.",
		},
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				const path = repositoryPath(context.filename);
				if (
					!path.startsWith("src/server/conversation/") ||
					path === "src/server/conversation/commands/transaction.ts" ||
					isTestFile(path) ||
					!isManualTransaction(node)
				) return;
				context.report({ node, messageId: "manualTransaction" });
			},
		};
	},
});
