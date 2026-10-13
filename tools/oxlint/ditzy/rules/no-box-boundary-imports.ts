import { defineRule, type ESTree } from "@oxlint/plugins";

import { importVisitors } from "../imports.ts";
import { importTarget, isTestFile, layerOf, repositoryPath } from "../path.ts";

// The client registry imports the Box clients until it loads them from `GET /api/boxes` (ticket 27).
const registrations = new Set(["src/client/box-windows/registry.tsx"]);
const sdk = { server: ["src/box-sdk/server", "src/box-sdk/shared"], client: ["src/box-sdk/client", "src/box-sdk/shared"], shared: ["src/box-sdk/shared"] };

/** Keep each Box behind the Box SDK, its folder loadable from anywhere, and the core out of Box folders except through the client registry. */
export const noBoxBoundaryImportsRule = defineRule({
	meta: {
		type: "problem",
		docs: { description: "A Box imports only its own folder, by relative path, and its layer's Box SDK, by `@/` path; only the client registry imports a Box." },
		messages: {
			boxImport: "A Box file imports its own folder by relative path and only the Box SDK entries for its layer by `@/` path, so the folder loads from anywhere: {{allowed}}.",
			coreImport: "Only the client Box registry and tests import from src/boxes.",
		},
	},
	createOnce(context) {
		return importVisitors((node: ESTree.Node, source: string) => {
			const path = repositoryPath(context.filename);
			if (isTestFile(path)) return;
			const target = importTarget(path, source);
			const box = /^src\/boxes\/([^/]+)\//.exec(path)?.[1];
			if (box === undefined) {
				if (path.startsWith("src/") && target !== undefined && /^src\/boxes(?:\/|$)/.test(target) && !registrations.has(path)) context.report({ node, messageId: "coreImport" });
				return;
			}
			if (target === undefined) return;
			const allowed = sdk[layerOf(path) ?? "shared"];
			if (source.startsWith(".") ? target.startsWith(`src/boxes/${box}/`) : source.startsWith("@/") && allowed.includes(target)) return;
			context.report({ node, messageId: "boxImport", data: { allowed: allowed.map((entry) => `@/${entry.slice("src/".length)}`).join(", ") } });
		});
	},
});
