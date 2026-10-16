import type { ESTree } from "@oxlint/plugins";

type Check = (node: ESTree.Node, source: string, typeOnly: boolean) => void;

const staticSpecifier = (node: ESTree.Expression): string | undefined => {
	if (node.type === "Literal") return typeof node.value === "string" ? node.value : undefined;
	return node.type === "TemplateLiteral" && node.expressions.length === 0 ? node.quasis[0]?.value.cooked ?? undefined : undefined;
};

/** Visit every module a file names: imports, re-exports, and dynamic imports with a static specifier. */
export const importVisitors = (check: Check) => ({
	ImportDeclaration: (node: ESTree.ImportDeclaration) => check(node.source, node.source.value, node.importKind === "type" || (
		node.specifiers.length > 0 && node.specifiers.every((specifier) => specifier.type === "ImportSpecifier" && specifier.importKind === "type"))),
	ExportNamedDeclaration: (node: ESTree.ExportNamedDeclaration) => {
		if (node.source === null) return;
		check(node.source, node.source.value, node.exportKind === "type" || (node.specifiers.length > 0 && node.specifiers.every((specifier) => specifier.exportKind === "type")));
	},
	ExportAllDeclaration: (node: ESTree.ExportAllDeclaration) => check(node.source, node.source.value, node.exportKind === "type"),
	ImportExpression: (node: ESTree.ImportExpression) => {
		const source = staticSpecifier(node.source);
		if (source !== undefined) check(node.source, source, false);
	},
});
