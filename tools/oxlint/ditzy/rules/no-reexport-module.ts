import { defineRule } from "@oxlint/plugins";
import { repositoryPath } from "../path.ts";

const existingBarrels = new Set([
	"src/server/artifact/index.ts", // Public entry for the Artifact store and inspection.
	"src/server/conversation/index.ts", // Conversation's enforced public entry.
	"src/server/generation-plan/index.ts", // Public Generation Plan compilation and inspection entry.
	"src/server/image/index.ts", // Public Image storage and delivery entry.
	"src/server/model-client/index.ts", // Public Model Client transport entry.
	"src/server/prompt-compiler/index.ts", // Public Prompt Plan compiler entry.
	"src/server/prompt-macros/index.ts", // Public server Prompt Macro entry.
	"src/server/prompt-preset/index.ts", // Public Prompt Preset library entry.
	"src/server/sillytavern/index.ts", // Public staged import and library entry.
	"src/server/workflows/index.ts", // Public Generation workflow entry.
	"src/shared/prompt-macros.ts", // Existing shared entry for Macro definitions and diagnostics.
]);

export const noReexportModuleRule = defineRule({
	meta: {
		type: "problem",
		messages: { barrel: "Import exports from their defining modules instead of adding a re-export-only module." },
	},
	create(context) {
		const path = repositoryPath(context.filename);
		if (path.startsWith("src/box-sdk/") || existingBarrels.has(path)) return {};
		return {
			Program(node) {
				if (node.body.length > 0 && node.body.every((statement) => statement.type === "ExportAllDeclaration" ||
					(statement.type === "ExportNamedDeclaration" && statement.source !== null))) {
					context.report({ node: node.body[0]!, messageId: "barrel" });
				}
			},
		};
	},
});
