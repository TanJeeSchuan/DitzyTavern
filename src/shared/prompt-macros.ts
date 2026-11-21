// @approved
//  The public shared macro barrel keeps importer/compiler imports small. Syntax recognition
// itself lives in prompt-macro-syntax so the evaluator and importer share one owner.
export { parseMacroDocument } from "./prompt-macro-syntax";
export type { MacroContext, MacroDocumentNode, MacroNode } from "./prompt-macro-syntax";
