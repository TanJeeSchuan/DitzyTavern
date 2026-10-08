// @approved
//  The public shared macro barrel keeps importer/compiler imports small. Syntax recognition
// itself lives in prompt-macro-syntax so the evaluator and importer share one owner.
export {
	isEscaped,
	parseMacroDocument,
	promptCommentEnd,
	scanMacroToken,
	sliceMacroDocument,
	unescapeMacroText,
} from "./prompt-macro-syntax";
export type { MacroArgument, MacroContext, MacroDocumentNode, MacroNode, MacroToken, TextNode } from "./prompt-macro-syntax";
