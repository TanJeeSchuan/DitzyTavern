import { defineRule, type ESTree } from "@oxlint/plugins";

import { repositoryPath } from "../path.ts";

const guardHelpers = new Set([
	"isBoolean",
	"isNumber",
	"isRow",
	"isString",
	"isStringArray",
]);

const isMigratedTransport = (filename: string): boolean => {
	const path = repositoryPath(filename);
	return path === "src/client/chat-history.ts" ||
		path.includes("/transport/") ||
		/[-.]transport\.[cm]?[jt]sx?$/.test(path);
};

/** Reject property-by-property payload decoders in migrated transport modules. */
export const noHandWrittenWireGuardsRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Use canonical TypeBox schemas to decode migrated client transports.",
		},
		messages: {
			handWrittenGuard:
				"Decode this wire payload with Value.Check and a schema from src/shared/contract, or call the shared schema-based decode helper. Property-by-property guards duplicate the wire contract.",
		},
	},
	createOnce(context) {
		const counts = new Map<ESTree.Node, number>();
		const containingFunction = (node: ESTree.Node): ESTree.Node | null => {
			let current: ESTree.Node | null = node.parent;
			while (current !== null && current.type !== "Program") {
				if (
					current.type === "FunctionDeclaration" ||
					current.type === "FunctionExpression" ||
					current.type === "ArrowFunctionExpression"
				) return current;
				current = current.parent;
			}
			return null;
		};

		return {
			before() {
				counts.clear();
			},
			CallExpression(node) {
				if (!isMigratedTransport(context.filename)) return;
				const isArrayGuard = node.callee.type === "MemberExpression" &&
					!node.callee.computed &&
					node.callee.object.type === "Identifier" &&
					node.callee.object.name === "Array" &&
					node.callee.property.type === "Identifier" &&
					node.callee.property.name === "isArray";
				const isHelperGuard = node.callee.type === "Identifier" &&
					guardHelpers.has(node.callee.name);
				if (!isArrayGuard && !isHelperGuard) return;
				const owner = containingFunction(node);
				if (owner !== null) counts.set(owner, (counts.get(owner) ?? 0) + 1);
			},
			"Program:exit"() {
				for (const [node, count] of counts) {
					if (count < 4) continue;
					context.report({ node, messageId: "handWrittenGuard" });
				}
			},
		};
	},
});
