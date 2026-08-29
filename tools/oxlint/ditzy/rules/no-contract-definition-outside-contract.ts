import { defineRule, type ESTree } from "@oxlint/plugins";

import { repositoryPath } from "../path.ts";

const schemaConstructors = new Set([
	"Object",
	"Union",
	"Intersect",
	"Composite",
	"Partial",
	"Pick",
	"Omit",
]);

const isBoundaryModule = (filename: string): boolean => {
	const path = repositoryPath(filename);
	return path.startsWith("src/client/") || path.startsWith("src/server/");
};

const schemaConstructor = (node: ESTree.CallExpression): boolean => {
	if (node.callee.type !== "MemberExpression" || node.callee.computed) return false;
	if (node.callee.object.type !== "Identifier") return false;
	if (node.callee.object.name !== "Type" && node.callee.object.name !== "t") return false;
	return node.callee.property.type === "Identifier" &&
		schemaConstructors.has(node.callee.property.name);
};

/** Keep wire-schema construction in the canonical shared contract directory. */
export const noContractDefinitionOutsideContractRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Keep TypeBox wire-schema definitions in src/shared/contract.",
		},
		messages: {
			outsideOwner:
				"Wire schemas are owned by src/shared/contract. Import or derive the canonical schema instead of defining a second representation here.",
		},
	},
	createOnce(context) {
		return {
			CallExpression(node) {
				if (!isBoundaryModule(context.filename) || !schemaConstructor(node)) return;
				context.report({ node, messageId: "outsideOwner" });
			},
		};
	},
});
