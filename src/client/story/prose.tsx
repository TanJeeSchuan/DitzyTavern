import MarkdownIt, { type Delimiter, type StateInline, type Token } from "markdown-it";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";

const QUOTE = 0x22;
// markdown-it's own text terminators plus the dialogue quotes, so the text rule stops at them.
const terminator = /[\n!#$%&*+\-:<=>@[\\\]^_`{}~"“”]/g;

const md = new MarkdownIt({ breaks: true }).disable(["code", "lheading"]);

md.inline.ruler.at("text", (state, silent) => {
	terminator.lastIndex = state.pos;
	const stop = Math.min(terminator.exec(state.src)?.index ?? state.posMax, state.posMax);
	if (stop === state.pos) return false;
	if (!silent) state.pending += state.src.slice(state.pos, stop);
	state.pos = stop;
	return true;
});

md.inline.ruler.before("emphasis", "dialogue", (state, silent) => {
	const char = state.src[state.pos];
	if (silent || (char !== "\"" && char !== "“" && char !== "”")) return false;
	const { can_open, can_close } = state.scanDelims(state.pos, false);
	state.push("text", "", 0).content = char;
	state.delimiters.push({
		marker: QUOTE,
		length: 0,
		token: state.tokens.length - 1,
		end: -1,
		open: char === "“" || (char === "\"" && can_open),
		close: char === "”" || (char === "\"" && can_close),
	});
	state.pos++;
	return true;
});

const toTag = (token: Token | undefined, type: string, nesting: 1 | -1) => {
	if (token === undefined) return;
	Object.assign(token, { type, tag: "span", nesting, markup: token.content, content: "" });
};

// An opening quote left unmatched closes where its enclosing element closes, without a
// closing mark: multi-paragraph dialogue opens a quote per paragraph, and a streaming
// quote is styled before its closing mark arrives.
md.inline.ruler2.before("fragments_join", "dialogue", (state: StateInline) => {
	const delimiters: Delimiter[] = [state.delimiters, ...state.tokens_meta.map((meta) => meta?.delimiters ?? [])]
		.flatMap((list) => list.map((delimiter) => ({ ...delimiter, end: delimiter.end === -1 ? -1 : (list[delimiter.end]?.token ?? -1) })))
		.filter((delimiter) => delimiter.marker === QUOTE && delimiter.open);
	for (const opener of delimiters) {
		toTag(state.tokens[opener.token], "dialogue_open", 1);
		if (opener.end !== -1) toTag(state.tokens[opener.end], "dialogue_close", -1);
	}
	for (const opener of delimiters.filter((delimiter) => delimiter.end === -1).toSorted((a, b) => b.token - a.token)) {
		let depth = 0;
		let at = opener.token + 1;
		for (; at < state.tokens.length; at++) {
			depth += state.tokens[at]?.nesting ?? 0;
			if (depth < 0) break;
		}
		state.tokens.splice(at, 0, new state.Token("dialogue_close", "span", -1));
	}
});

md.renderer.rules.dialogue_open = (tokens, index) => `<span class="prose-dialogue">${md.utils.escapeHtml(tokens[index]?.markup ?? "")}`;
md.renderer.rules.dialogue_close = (tokens, index) => `${md.utils.escapeHtml(tokens[index]?.markup ?? "")}</span>`;

export function renderBlocks(text: string): string[] {
	const env = {};
	const blocks: Token[][] = [];
	for (const token of md.parse(text, env)) {
		if (token.level === 0 && token.nesting !== -1) blocks.push([]);
		blocks.at(-1)?.push(token);
	}
	return blocks.map((block) => md.renderer.render(block, md.options, env));
}

const CHUNK = 300;
const FADE = "animate-in fade-in-0 duration-450";
const sentenceEnd = /[.!?…]+["”')\]*_~]*(?=\s)/g;

const lineStart = (text: string, line: number) => {
	let offset = 0;
	for (let index = 0; index < line; index++) offset = text.indexOf("\n", offset) + 1;
	return offset;
};

// How much of a streaming text to show: every block before the last in full, and the
// last block only up to the latest sentence end that completes a chunk of at least
// CHUNK characters.
export function revealedLength(text: string): number {
	const last = md.parse(text, {}).findLast((token) => token.level === 0 && token.nesting !== -1);
	const start = lineStart(text, last?.map?.[0] ?? 0);
	let revealed = start;
	for (const match of text.slice(start).matchAll(sentenceEnd)) {
		const end = start + match.index + match[0].length;
		if (end - revealed >= CHUNK) revealed = end;
	}
	return revealed;
}

function fadeTextAfter(root: HTMLElement, offset: number) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) if (node instanceof Text) nodes.push(node);
	let seen = 0;
	for (const node of nodes) {
		const length = node.length;
		if (seen + length > offset) {
			const fresh = offset > seen ? node.splitText(offset - seen) : node;
			const span = Object.assign(document.createElement("span"), { className: FADE });
			fresh.replaceWith(span);
			span.append(fresh);
		}
		seen += length;
	}
}

// Once a Prose has streamed, blocks it mounts fade in whole and text added to a mounted
// block fades in from where it previously ended. History that never streamed stays still.
// Memoized because React rewrites dangerouslySetInnerHTML on every render, which would wipe
// the fade spans of a block whose html did not change.
const ProseBlock = memo(function ProseBlock({ html, fade }: { html: string; fade: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	const [entering] = useState(fade);
	const shownLength = useRef<number>(undefined);
	useLayoutEffect(() => {
		const element = ref.current;
		if (element === null) return;
		if (fade && shownLength.current !== undefined) fadeTextAfter(element, shownLength.current);
		shownLength.current = element.textContent.length;
	}, [html, fade]);
	return <div ref={ref} className={entering ? `prose-block ${FADE}` : "prose-block"} dangerouslySetInnerHTML={{ __html: html }} />;
});

export function Prose({ text, streaming }: { text: string; streaming: boolean }) {
	const [streamed, setStreamed] = useState(streaming);
	if (streaming && !streamed) setStreamed(true);
	const shown = streaming ? text.slice(0, revealedLength(text)) : text;
	const blocks = useMemo(() => renderBlocks(shown), [shown]);
	return blocks.map((html, index) => <ProseBlock key={index} html={html} fade={streamed} />);
}
