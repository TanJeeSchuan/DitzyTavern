import { defineRule } from "@oxlint/plugins";
import { posix } from "node:path";
import { isTestFile, repositoryPath } from "../path.ts";

const tables = new Set(["messageTable", "messageVariantTable", "activeGenerationTable"]);

export const noConversationInternalImportsRule = defineRule({
 meta: {
  type: "problem",
  docs: { description: "Use the Conversation public barrel and read seams." },
  messages: {
   internalImport: "Import Conversation through its public barrel.",
   tableImport: "Read Conversation tables through Conversation's public seams.",
  },
 },
 createOnce(context) {
  return {
   ImportDeclaration(node) {
    const path = repositoryPath(context.filename);
    if (path.startsWith("src/server/conversation/") || path === "src/server/database/schema.ts") return;
    const source = node.source.value;
    if (typeof source !== "string") return;
    const resolved = source.startsWith(".") ? posix.normalize(posix.join(posix.dirname(path), source)) : source;
    if (resolved.startsWith("src/server/conversation/") && !/^src\/server\/conversation\/index(?:\.ts)?$/.test(resolved)) {
     context.report({ node, messageId: "internalImport" });
    }
    if (isTestFile(path) || !/^src\/server\/database\/schema(?:\.ts)?$/.test(resolved)) return;
    for (const specifier of node.specifiers) {
     if (specifier.type === "ImportNamespaceSpecifier" ||
      (specifier.type === "ImportSpecifier" && specifier.imported.type === "Identifier" && tables.has(specifier.imported.name))) {
      context.report({ node: specifier, messageId: "tableImport" });
     }
    }
   },
  };
 },
});
