import { defineRule, type ESTree } from "@oxlint/plugins";

import { isTestFile, repositoryPath } from "../path.ts";

const isServerModule = (source: string): boolean =>
	/(?:^|\/)server(?:\/|$)/.test(source) || source.startsWith("@/server/");

const sourceText = (node: ESTree.ImportDeclaration): string | null =>
	typeof node.source.value === "string" ? node.source.value : null;

/** Keep the client decoupled from server runtime code: server modules may only be imported for types. */
export const noServerRuntimeImportsInClientRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Restrict client imports of server modules to type-only imports.",
		},
		messages: {
			serverRuntimeDependency:
				"src/client depends on server code only through type-only imports. Move the runtime dependency behind the transport boundary or into src/shared.",
		},
	},
	createOnce(context) {
		return {
			ImportDeclaration(node) {
				const path = repositoryPath(context.filename);
				if (!path.startsWith("src/client/") || isTestFile(path)) return;
				const source = sourceText(node);
				if (source === null || !isServerModule(source)) return;
				if (node.importKind === "type") return;
				context.report({ node: node.source, messageId: "serverRuntimeDependency" });
			},
		};
	},
});
