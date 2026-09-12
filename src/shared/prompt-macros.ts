// ==[HUMAN APPROVED]== Shared macro syntax helpers. The Chevrotain-backed evaluator owns
// expansion; this module keeps the small source scanner used by the SillyTavern
// importer and exposes the evaluator through the established shared barrel.

const isEscaped = (source: string, index: number): boolean => {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
	return slashes % 2 === 1;
};

// ==[HUMAN APPROVED]== Macro context provided by the caller. `self` is the name of the
// Participant whose Definition (or opening) is being compiled; `other` is the
// name of the other controlled Participant. Authored preset text instead
// passes the current human-controlled Participant as `self` and the current
// model-controlled Participant as `other`; only recognition is name-based,
// so warning-only scans may pass a placeholder context.
export interface MacroContext {
	self: string;
	other: string;
}

interface MacroMatch {
	name: string;
	// ==[HUMAN APPROVED]== Index just past the closing `}}`.
	end: number;
}

// ==[HUMAN APPROVED]== Matches a `{{...}}` starting exactly at `start`; the name is the text
// between the braces, unmodified, for the importer translation pass.
const matchMacro = (source: string, start: number): MacroMatch | null => {
	if (source[start] !== "{" || source[start + 1] !== "{") return null;
	const close = source.indexOf("}}", start + 2);
	if (close === -1) return null;
	return { name: source.slice(start + 2, close), end: close + 2 };
};
// ==[HUMAN APPROVED]== Matches an inline `{{// ... }}` or scoped
// `{{//}}...{{///}}` Prompt Comment starting exactly at `start`. Inline bodies
// may span lines and contain macro delimiters, so they end at the `}}` that
// balances the opening `{{`. Returns the index just past the complete comment,
// or null when unbalanced.
const matchPromptComment = (source: string, start: number): number | null => {
	if (!source.startsWith("{{//", start)) return null;
	if (source.startsWith("{{//}}", start)) {
		for (let index = start + "{{//}}".length; index < source.length - "{{///}}".length + 1; index += 1) {
			if (source.startsWith("{{///}}", index) && !isEscaped(source, index)) {
				return index + "{{///}}".length;
			}
		}
		return null;
	}
	let depth = 0;
	for (let index = start; index < source.length; index += 1) {
		if (source.startsWith("{{", index)) depth += 1;
		else if (source.startsWith("}}", index) && !isEscaped(source, index)) depth -= 1;
		else continue;
		if (depth === 0) return index + 2;
		index += 1;
	}
	return null;
};

// ==[HUMAN APPROVED]== One token of the macro language as both expansion and SillyTavern import
// translation scan it. The token's `end` is always the index just past the
// consumed characters; a token that is an escape (or a backslash pair) stays
// literal text in every consumer, while a plain macro or comment is active
// and each consumer decides what active means for it.
export type MacroToken =
	| { kind: "backslash-pair"; end: number }
	| { kind: "escaped-macro"; name: string; end: number }
	| { kind: "escaped-comment"; end: number }
	| { kind: "comment"; end: number }
	| { kind: "macro"; name: string; end: number }
	| { kind: "char"; end: number };

// ==[HUMAN APPROVED]== The single shared recognition step of the macro language, so expansion
// and import translation can never disagree about which macros are active:
// `\\` is one escaped backslash that leaves the following macro active, a
// backslash before a recognized macro or a balanced Prompt Comment escapes
// that macro or comment whole, and an active Prompt Comment is recognized
// ahead of a macro so its body is never evaluated. `recognizes` names the
// consumer's vocabulary: native expansion recognizes `self`/`other`, import
// translation recognizes the `user`/`char` names it rewrites.
export function scanMacroToken(
	source: string,
	index: number,
	recognizes: (name: string) => boolean,
): MacroToken {
	if (source[index] === "\\") {
		if (source[index + 1] === "\\") return { kind: "backslash-pair", end: index + 2 };
		const escapedCommentEnd = matchPromptComment(source, index + 1);
		if (escapedCommentEnd !== null) {
			return { kind: "escaped-comment", end: escapedCommentEnd };
		}
		const escaped = matchMacro(source, index + 1);
		if (escaped !== null && recognizes(escaped.name)) {
			return { kind: "escaped-macro", name: escaped.name, end: escaped.end };
		}
		return { kind: "char", end: index + 1 };
	}
	if (source[index] !== "{") return { kind: "char", end: index + 1 };
	const commentEnd = matchPromptComment(source, index);
	if (commentEnd !== null) return { kind: "comment", end: commentEnd };
	const macro = matchMacro(source, index);
	if (macro !== null) return { kind: "macro", name: macro.name, end: macro.end };
	return { kind: "char", end: index + 1 };
}
