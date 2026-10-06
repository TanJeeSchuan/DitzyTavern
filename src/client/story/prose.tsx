import MarkdownIt, { type Delimiter, type StateInline, type Token } from "markdown-it";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { imageAnchor, imageReferenceAt } from "../../shared/image-reference";
import { imageSrc } from "../lib/image";
import { useOpenImageAt } from "../ImageDialog";

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

md.inline.ruler.before("image", "image_reference", (state, silent) => {
	const reference = imageReferenceAt(state.src, state.pos);
	if (reference === undefined || reference.end > state.posMax) return false;
	if (!silent) {
		const token = state.push("image", "img", 0);
		token.content = reference.name;
		token.attrSet("hash", reference.hash);
	}
	state.pos = reference.end;
	return true;
});

md.renderer.rules.image = (tokens, index) => {
	const token = tokens[index];
	const name = md.utils.escapeHtml(token?.content ?? "");
	const hash = String(token?.attrGet("hash") ?? "");
	if (hash === "") return name;
	return `<button type="button" class="prose-image" data-image-hash="${hash}" data-image-name="${name}"><img src="${imageSrc(hash)}" alt="${name}" loading="lazy"><span class="prose-image-anchor">${md.utils.escapeHtml(imageAnchor(token?.content ?? ""))}</span></button>`;
};

export function renderBlocks(text: string): string[] {
	const env = {};
	const blocks: Token[][] = [];
	for (const token of md.parse(text, env)) {
		if (token.level === 0 && token.nesting !== -1) blocks.push([]);
		blocks.at(-1)?.push(token);
	}
	return blocks.map((block) => md.renderer.render(block, md.options, env));
}

const FIRST = 80;
const CHUNK = 300;
// A soft edge 6em wide wipes each span from left to right. An inline span's mask runs along
// its lines laid end to end, so the edge travels in reading order, line after line.
const WIPE = "animate-wipe-in mask-no-repeat mask-size-[calc(200%+6em)_100%] mask-r-from-[calc(50%-3em)] mask-r-to-[calc(50%+3em)]";
const MS_PER_CHAR = 2.5;
const EDGE_CHARS = 12;
const sentenceEnd = /[.!?…]+["”')\]*_~]*(?=\s)/g;

const lineStart = (text: string, line: number) => {
	let offset = 0;
	for (let index = 0; index < line; index++) offset = text.indexOf("\n", offset) + 1;
	return offset;
};

// How much of a streaming text to show: every block before the last in full, and the
// last block up to a sentence end. A reveal falls due each time CHUNK more characters
// have streamed (FIRST for the opening one, so the first ink lands quickly) and shows up
// to the latest sentence end before that point, or the next one if none came, so reveals
// keep a steady pace however the sentences run.
export function revealedLength(text: string): number {
	const last = md.parse(text, {}).findLast((token) => token.level === 0 && token.nesting !== -1);
	const start = lineStart(text, last?.map?.[0] ?? 0);
	const ends = [...text.slice(start).matchAll(sentenceEnd)].map((match) => start + match.index + match[0].length);
	let revealed = start;
	for (let due = revealed + (revealed === 0 ? FIRST : CHUNK); due <= text.length; due = revealed + CHUNK) {
		const next = ends.findLast((end) => end > revealed && end < due) ?? ends.find((end) => end > revealed);
		if (next === undefined) break;
		revealed = next;
	}
	return revealed;
}

function wipeTextAfter(root: HTMLElement, offset: number) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const nodes: Text[] = [];
	for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) if (node instanceof Text) nodes.push(node);
	let seen = 0;
	for (const node of nodes) {
		const length = node.length;
		if (seen + length > offset) {
			const fresh = offset > seen ? node.splitText(offset - seen) : node;
			const span = Object.assign(document.createElement("span"), { className: WIPE });
			// Each span starts when the edge reaches its first character, so spans split by
			// markup read as one continuous wipe.
			span.style.animationDelay = `${(Math.max(seen, offset) - offset) * MS_PER_CHAR}ms`;
			span.style.animationDuration = `${(fresh.length + EDGE_CHARS) * MS_PER_CHAR}ms`;
			fresh.replaceWith(span);
			span.append(fresh);
		}
		seen += length;
	}
}

// Once a Prose has streamed, blocks it mounts wipe in whole and text added to a mounted
// block wipes in from where it previously ended. History that never streamed stays still.
// Memoized because React rewrites dangerouslySetInnerHTML on every render, which would drop
// the wipe spans of a block whose html did not change.
const ProseBlock = memo(function ProseBlock({ html, fade, openImageAt }: { html: string; fade: boolean; openImageAt: (target: EventTarget) => void }) {
	const ref = useRef<HTMLDivElement>(null);
	const shownLength = useRef(fade ? 0 : undefined);
	useLayoutEffect(() => {
		const element = ref.current;
		if (element === null) return;
		if (fade && shownLength.current !== undefined) wipeTextAfter(element, shownLength.current);
		shownLength.current = element.textContent.length;
	}, [html, fade]);
	return (
		<div
			ref={ref}
			className="prose-block"
			dangerouslySetInnerHTML={{ __html: html }}
			onErrorCapture={(event) => {
				const button = event.target instanceof HTMLImageElement ? event.target.closest<HTMLElement>("[data-image-hash]") : null;
				if (button === null) return;
				button.dataset.missing = "true";
				button.setAttribute("disabled", "");
			}}
			onClick={(event) => openImageAt(event.target)}
		/>
	);
});

export function Prose({ text, streaming }: { text: string; streaming: boolean }) {
	const openImageAt = useOpenImageAt();
	const [streamed, setStreamed] = useState(streaming);
	if (streaming && !streamed) setStreamed(true);
	const shown = streaming ? text.slice(0, revealedLength(text)) : text;
	const blocks = useMemo(() => renderBlocks(shown), [shown]);
	return blocks.map((html, index) => <ProseBlock key={index} html={html} fade={streamed} openImageAt={openImageAt} />);
}
