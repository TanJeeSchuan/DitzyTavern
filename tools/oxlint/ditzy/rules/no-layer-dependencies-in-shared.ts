import { defineRule, type ESTree } from "@oxlint/plugins";

import { isTestFile, repositoryPath } from "../path.ts";

const isLayerDependency = (source: string): boolean =>
	source === "elysia" ||
	source.startsWith("bun:") ||
	/(?:^|\/)server(?:\/|$)/.test(source) ||
	/(?:^|\/)client(?:\/|$)/.test(source) ||
	source.startsWith("@/server/") ||
	source.startsWith("@/client/");

const sourceText = (node: ESTree.ImportDeclaration): string | null =>
	typeof node.source.value === "string" ? node.source.value : null;

/** Keep shared production code independent of client, server, and runtime APIs. */
export const noLayerDependenciesInSharedRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Keep src/shared independent of client, server, Elysia, and Bun APIs.",
		},
		messages: {
			layerDependency:
				"src/shared cannot depend on client, server, Elysia, or Bun APIs, including through type-only imports. Move the adapter or runtime type to its owning layer.",
		},
	},
	createOnce(context) {
		return {
			ImportDeclaration(node) {
				const path = repositoryPath(context.filename);
				if (!path.startsWith("src/shared/") || isTestFile(path)) return;
				const source = sourceText(node);
				if (source === null || !isLayerDependency(source)) return;
				context.report({ node: node.source, messageId: "layerDependency" });
			},
		};
	},
});
