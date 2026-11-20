import type { ESTree } from "@oxlint/plugins";
import { staticSpecifier } from "./imports.ts";

export const memberName = (node: ESTree.MemberExpression): string | undefined =>
	node.computed ? staticSpecifier(node.property) : node.property.name;

export const unwrapExpression = (node: ESTree.Expression): ESTree.Expression => {
	switch (node.type) {
		case "ChainExpression": return unwrapExpression(node.expression);
		case "TSAsExpression":
		case "TSNonNullExpression":
		case "TSSatisfiesExpression":
		case "TSTypeAssertion": return unwrapExpression(node.expression);
		default: return node;
	}
};
