import { defineRule } from "@oxlint/plugins";
import { importVisitors, moduleExportName, staticSpecifier } from "../imports.ts";
import { importTarget, isTestFile, repositoryPath } from "../path.ts";

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
  const path = () => repositoryPath(context.filename);
  const outside = () => !path().startsWith("src/server/conversation/");
  const readsSchema = (source: string) => outside() && path() !== "src/server/database/schema.ts" && !isTestFile(path()) &&
   importTarget(path(), source) === "src/server/database/schema";
  const visitors = importVisitors((node, source) => {
   const target = importTarget(path(), source);
   if (outside() && target?.startsWith("src/server/conversation/") && target !== "src/server/conversation/index") context.report({ node, messageId: "internalImport" });
  });
  return {
   ...visitors,
   ImportDeclaration(node) {
    visitors.ImportDeclaration(node);
    if (!readsSchema(node.source.value)) return;
    for (const specifier of node.specifiers) {
     if (specifier.type === "ImportNamespaceSpecifier" || (specifier.type === "ImportSpecifier" && tables.has(moduleExportName(specifier.imported)))) {
      context.report({ node: specifier, messageId: "tableImport" });
     }
    }
   },
   ExportNamedDeclaration(node) {
    visitors.ExportNamedDeclaration(node);
    if (node.source === null || !readsSchema(node.source.value)) return;
    for (const specifier of node.specifiers) if (tables.has(moduleExportName(specifier.local))) context.report({ node: specifier, messageId: "tableImport" });
   },
   ExportAllDeclaration(node) {
    visitors.ExportAllDeclaration(node);
    if (readsSchema(node.source.value)) context.report({ node, messageId: "tableImport" });
   },
   ImportExpression(node) {
    visitors.ImportExpression(node);
    const source = staticSpecifier(node.source);
    if (source !== undefined && readsSchema(source)) context.report({ node, messageId: "tableImport" });
   },
  };
 },
});
