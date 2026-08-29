import { defineRule, type ESTree } from "@oxlint/plugins";

import { isTestFile, repositoryPath } from "../path.ts";

const isRuntimeImport = (source: string): boolean =>
	source === "elysia" ||
	source.startsWith("bun:") ||
	/(?:^|\/)server(?:\/|$)/.test(source) ||
	/(?:^|\/)client(?:\/|$)/.test(source) ||
	source.startsWith("@/server/") ||
	source.startsWith("@/client/");

const sourceText = (node: ESTree.ImportDeclaration): string | null =>
	typeof node.source.value === "string" ? node.source.value : null;

/** Prevent shared modules from acquiring runtime, server, or client dependencies. */
export const noRuntimeImportsInSharedRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Keep src/shared runtime-independent.",
		},
		messages: {
			runtimeDependency:
				"src/shared owns runtime-independent contracts and values. Move this adapter to src/server or src/client, then import the shared contract from that runtime layer.",
		},
	},
	createOnce(context) {
		return {
			ImportDeclaration(node) {
				const path = repositoryPath(context.filename);
				if (!path.startsWith("src/shared/") || isTestFile(path)) return;
				const source = sourceText(node);
				if (source === null || !isRuntimeImport(source)) return;
				context.report({ node: node.source, messageId: "runtimeDependency" });
			},
		};
	},
});
