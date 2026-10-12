import { defineRule } from "@oxlint/plugins";

import { importVisitors } from "../imports.ts";
import { importTarget, isTestFile, layerOf, repositoryPath } from "../path.ts";

const isServerModule = (path: string, source: string): boolean =>
	/(?:^|\/)server(?:\/|$)/.test(source) || source.startsWith("@/server/") || layerOf(importTarget(path, source) ?? "") === "server";

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
		return importVisitors((node, source, typeOnly) => {
			const path = repositoryPath(context.filename);
			if (layerOf(path) !== "client" || isTestFile(path) || typeOnly || !isServerModule(path, source)) return;
			context.report({ node, messageId: "serverRuntimeDependency" });
		});
	},
});
