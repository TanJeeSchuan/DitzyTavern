// ==[HUMAN APPROVED]== The shared Prompt macro processor. One left-to-right pass owns macro
// expansion, Prompt Comments, and backslash escaping so Participant-owned
// text, openings, and authored preset instruction blocks can never drift
// into a second parser. The server Prompt Compiler consumes it for rendered
// output; the preset editor consumes the same function on draft text so the
// small unknown-macro warning previews exactly what the compiler will warn
// about.
//
// `{{self}}` and `{{other}}` expand case-sensitively and in one pass;
// expansion output is never rescanned. A backslash escapes a recognized
// macro (`\{{self}}` renders `{{self}}`) and a Prompt Comment
// (`\{{// note }}` renders the comment literally). A Prompt Comment uses
// `{{// ... }}` or the scoped `{{//}}...{{///}}` form. It is dropped whole
// during that same pass, so its body is never evaluated and never warns.
// Unknown macros remain literal and are reported as warnings labeled by the
// caller.

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
const matchComment = (source: string, start: number): number | null => {
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
		const char = source[index];

		if (char === "\\") {
			const next = source[index + 1];
			if (next === "\\") {
				output += "\\";
				index += 2;
				continue;
			}
			const escaped = matchMacro(source, index + 1);
			if (escaped !== null && recognize(escaped.name, context) !== null) {
				output += `{{${escaped.name}}}`;
				index = escaped.end;
				continue;
			}
			// ==[HUMAN APPROVED]== A backslash before a balanced Prompt Comment keeps the whole comment
			// as literal text, exactly like an escaped macro; it is no longer an
			// active comment, so nothing inside it is skipped or warned about.
			const escapedCommentEnd = matchComment(source, index + 1);
			if (escapedCommentEnd !== null) {
				output += source.slice(index + 1, escapedCommentEnd);
				index = escapedCommentEnd;
				continue;
			}
			output += "\\";
			index += 1;
			continue;
		}

		const commentEnd = char === "{" ? matchComment(source, index) : null;
		if (commentEnd !== null) {
			index = commentEnd;
			continue;
		}

		const macro = char === "{" ? matchMacro(source, index) : null;
		if (macro !== null) {
			const expanded = recognize(macro.name, context);
			if (expanded !== null) {
				output += expanded;
			} else {
				warnings.push({ block: blockLabel, macro: `{{${macro.name}}}` });
				output += `{{${macro.name}}}`;
			}
			index = macro.end;
			continue;
		}

		output += char;
		index += 1;
	}

	return { text: output, warnings };
}
