import { defineRule, type ESTree } from "@oxlint/plugins";

import { importTarget, isTestFile, layerOf, repositoryPath } from "../path.ts";

const registrations = new Set(["src/shared/contract/box.ts", "src/server/box/registry.ts", "src/client/box-windows/registry.tsx"]);
const sdk = { server: ["src/box-sdk/server", "src/box-sdk/shared"], client: ["src/box-sdk/client", "src/box-sdk/shared"], shared: ["src/box-sdk/shared"] };

/** Keep each Box behind the Box SDK, and the core out of Box folders except through the registrations. */
export const noBoxBoundaryImportsRule = defineRule({
	meta: {
		type: "problem",
		docs: { description: "A Box imports only its own folder and its layer's Box SDK; only the registrations import a Box." },
		messages: {
			boxImport: "A Box file imports only its own folder and the Box SDK entries for its layer: {{allowed}}.",
			coreImport: "Only the Box registrations and tests import from src/boxes.",
		},
	},
	createOnce(context) {
		const check = (node: ESTree.Node, source: unknown) => {
			const path = repositoryPath(context.filename);
			if (typeof source !== "string" || isTestFile(path)) return;
			const target = importTarget(path, source);
			const box = /^src\/boxes\/([^/]+)\//.exec(path)?.[1];
			if (box === undefined) {
				if (path.startsWith("src/") && /^src\/boxes(?:\/|$)/.test(target) && !registrations.has(path)) context.report({ node, messageId: "coreImport" });
				return;
			}
			if (target === source || target.startsWith(`src/boxes/${box}/`)) return;
			const allowed = sdk[layerOf(path) ?? "shared"];
			if (!allowed.includes(target)) context.report({ node, messageId: "boxImport", data: { allowed: allowed.join(", ") } });
		};
		return {
			ImportDeclaration: (node) => check(node.source, node.source.value),
			ExportNamedDeclaration: (node) => { if (node.source !== null) check(node.source, node.source.value); },
			ExportAllDeclaration: (node) => check(node.source, node.source.value),
			ImportExpression: (node) => { if (node.source.type === "Literal") check(node.source, node.source.value); },
		};
	},
});
