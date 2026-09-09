// ==[HUMAN APPROVED]== The shared Prompt macro processor. One left-to-right pass owns macro
// expansion, Prompt Comments, and backslash escaping so Participant-owned
// text, openings, authored preset instruction blocks, and SillyTavern import
// translation can never drift into a second parser. The server Prompt
// Compiler consumes it for rendered output; the preset editor consumes the
// same function on draft text so the small unknown-macro warning previews
// exactly what the compiler will warn about; the SillyTavern importer
// consumes the same token scan so its translation agrees about which macros
// are active.
//
// `{{self}}` and `{{other}}` expand case-sensitively and in one pass;
// expansion output is never rescanned. A backslash escapes a recognized
// macro (`\{{self}}` renders `{{self}}`) and a Prompt Comment
// (`\{{// note }}` renders the comment literally). A pair of backslashes
// renders one backslash and leaves the following macro active. A Prompt
// Comment uses `{{// ... }}` or the scoped `{{//}}...{{///}}` form. It is
// dropped whole during that same pass, so its body is never evaluated and
// never warns. Unknown macros remain literal and are reported as warnings
// labeled by the caller.

import type { PromptWarning } from "./contract/conversation-schema";

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

export interface ExpansionResult {
	text: string;
	warnings: readonly PromptWarning[];
}

// ==[HUMAN APPROVED]== Version-one recognized macros. Deliberately tiny: general SillyTavern
// macro compatibility beyond `{{self}}`/`{{other}}` is out of scope.
// Returns the expanded value for a recognized macro name, or null when the
// name is unknown. Case-sensitive: `{{SELF}}` and `{{ self }}` are unknown.
const recognize = (name: string, context: MacroContext): string | null => {
	switch (name) {
		case "self":
			return context.self;
		case "other":
			return context.other;
		default:
			return null;
	}
};

interface MacroMatch {
	name: string;
	// ==[HUMAN APPROVED]== Index just past the closing `}}`.
	end: number;
}

// ==[HUMAN APPROVED]== Matches a `{{...}}` starting exactly at `start`; the name is the text
// between the braces, unmodified, so `{{SELF}}` and `{{ self }}` are unknown.
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
		const close = source.indexOf("{{///}}", start + "{{//}}".length);
		return close === -1 ? null : close + "{{///}}".length;
	}
	let depth = 0;
	for (let index = start; index < source.length; index += 1) {
		if (source.startsWith("{{", index)) depth += 1;
		else if (source.startsWith("}}", index)) depth -= 1;
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

// ==[HUMAN APPROVED]== Expands macros in authored text in one left-to-right pass. Recognized
// macros expand to their context value (never rescanned); `\{{name}}` before
// a recognized macro renders the macro literally, and `\{{// ... }}` renders
// the whole comment literally; unknown `{{...}}` stays
// literal and is reported as a warning labeled by the caller. A Prompt Comment
// is recognized ahead of a macro, so its body is skipped rather than parsed.
export function expandText(
	source: string,
	context: MacroContext,
	blockLabel: string,
): ExpansionResult {
	const warnings: PromptWarning[] = [];
	let output = "";
	let index = 0;

	while (index < source.length) {
		const token = scanMacroToken(source, index, (name) => recognize(name, context) !== null);
		if (token.kind === "backslash-pair") {
			output += "\\";
		} else if (token.kind === "escaped-macro") {
			output += `{{${token.name}}}`;
		} else if (token.kind === "escaped-comment") {
			output += source.slice(index + 1, token.end);
		} else if (token.kind === "comment") {
			// ==[HUMAN APPROVED]== The active comment is dropped whole; its body is never
			// evaluated and never warns.
		} else if (token.kind === "macro") {
			const expanded = recognize(token.name, context);
			if (expanded !== null) {
				output += expanded;
			} else {
				warnings.push({ block: blockLabel, macro: `{{${token.name}}}` });
				output += `{{${token.name}}}`;
			}
		} else {
			output += source[index];
		}
		index = token.end;
	}

	return { text: output, warnings };
}
