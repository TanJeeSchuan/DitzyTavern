import { defineRule } from "@oxlint/plugins";

import { importVisitors } from "../imports.ts";
import { importTarget, isTestFile, layerOf, repositoryPath } from "../path.ts";

const isLayerDependency = (path: string, source: string): boolean =>
	source === "elysia" ||
	source.startsWith("bun:") ||
	/(?:^|\/)server(?:\/|$)/.test(source) ||
	/(?:^|\/)client(?:\/|$)/.test(source) ||
	source.startsWith("@/server/") ||
	source.startsWith("@/client/") ||
	["server", "client"].includes(layerOf(importTarget(path, source) ?? "") ?? "");

/** Keep shared production code independent of client, server, and runtime APIs. */
export const noLayerDependenciesInSharedRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description: "Keep src/shared and Box shared files independent of client, server, Elysia, and Bun APIs.",
		},
		messages: {
			layerDependency:
				"src/shared cannot depend on client, server, Elysia, or Bun APIs, including through type-only imports. Move the adapter or runtime type to its owning layer.",
		},
	},
	createOnce(context) {
		return importVisitors((node, source) => {
			const path = repositoryPath(context.filename);
			if (layerOf(path) !== "shared" || isTestFile(path) || !isLayerDependency(path, source)) return;
			context.report({ node, messageId: "layerDependency" });
		});
	},
});
