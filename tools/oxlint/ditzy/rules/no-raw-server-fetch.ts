import { defineRule, type ESTree, type SourceCode } from "@oxlint/plugins";
import { memberName } from "../members.ts";
import { isTestFile, repositoryPath } from "../path.ts";
import { referenceOf } from "../scope.ts";

const isGlobalRead = (source: SourceCode, node: Extract<ESTree.Node, { type: "Identifier" }>): boolean => {
	const reference = referenceOf(source, node);
	return reference !== undefined && reference.isRead() && (reference.resolved === null ||
		(reference.resolved.scope.type === "global" && reference.resolved.defs.length === 0));
};

const guardedFetchFiles = new Set([
	"src/server/model-client/model-fetch.ts", // Shared model transport policy.
	"src/server/box/sandboxed-deps.ts", // Fixed package origin, no redirects, time and byte limits.
	"src/server/authoring/provider.ts", // Creator Mode's libfx transport rejects redirects and owns its inactivity deadline.
	"src/server/decision-model/index.ts", // Passes the fallback fetch into fetchWithTimeout.
	"src/server/model-client/chat-completions.ts", // Injects a resolved-destination transport that rejects redirects and owns stream timeouts.
	"src/server/model-client/discovery.ts", // Passes the fallback fetch into fetchWithTimeout.
	"src/server/model-client/embeddings.ts", // Passes the fallback fetch into fetchWithTimeout.
	"src/server/model-client/painting.ts", // Injects a fixed endpoint and rejects redirects on image requests.
	"src/server/model-client/test-connection.ts", // Its probe fetches the resolved destination with redirects disabled.
	"src/server/updates.ts", // The update checker uses its own short deadline and fixed GHCR URLs.
]);

export const noRawServerFetchRule = defineRule({
	meta: {
		type: "problem",
		messages: { rawFetch: "Use the guarded server transport instead of the global fetch." },
	},
	create(context) {
		const path = repositoryPath(context.filename);
		if (!path.startsWith("src/server/") || isTestFile(path) || guardedFetchFiles.has(path)) return {};
		return {
			Identifier(node) {
				if (node.name === "fetch" && node.parent.type !== "TSTypeQuery" && isGlobalRead(context.sourceCode, node)) {
					context.report({ node, messageId: "rawFetch" });
				}
			},
			MemberExpression(node) {
				const root = node.object;
				if (root.type === "Identifier" && (root.name === "globalThis" || root.name === "global") &&
					memberName(node) === "fetch" && isGlobalRead(context.sourceCode, root)) {
					context.report({ node, messageId: "rawFetch" });
				}
			},
		};
	},
});
