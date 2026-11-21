import type { ESTree, SourceCode } from "@oxlint/plugins";

export const referenceOf = (source: SourceCode, node: Extract<ESTree.Node, { type: "Identifier" }>) =>
	source.getScope(node).references.find((reference) => reference.identifier === node);
