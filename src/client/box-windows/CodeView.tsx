import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import { useEffect, useRef } from "react";

const languages = { javascript: () => javascript(), json: () => json(), text: () => [] } as const;
export type CodeLanguage = keyof typeof languages;

// @approved
//  Code the agent wrote or read, highlighted and read-only. Guest code is only
// ever this editor's text, never markup in the page; the highlighter's token
// classes take the app's theme colours from the stylesheet.
export function CodeView({ text, language, label }: { text: string; language: CodeLanguage; label: string }) {
	const host = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (host.current === null) return;
		const view = new EditorView({
			parent: host.current,
			state: EditorState.create({
				doc: text,
				extensions: [
					EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.lineWrapping, lineNumbers(),
					syntaxHighlighting(classHighlighter), languages[language](), EditorView.contentAttributes.of({ "aria-label": label }),
				],
			}),
		});
		return () => view.destroy();
	}, [text, language, label]);
	return <div ref={host} className="create-box-code" />;
}
