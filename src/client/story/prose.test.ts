import { describe, expect, test } from "bun:test";
import { renderBlocks, revealedLength, settledFloor } from "./prose";

const render = (text: string) => renderBlocks(text).join("");

describe("renderBlocks", () => {
	test("wraps dialogue in curly quotes, curls apostrophes, and nests emphasis inside it", () => {
		expect(render("\"I don't *think* I'm in charge.\" He left.")).toBe(
			"<p><span class=\"prose-dialogue\">“I don’t <em>think</em> I’m in charge.”</span> He left.</p>\n",
		);
	});

	test("matches curly quotes", () => {
		expect(render("She said “hi”.")).toBe("<p>She said <span class=\"prose-dialogue\">“hi”</span>.</p>\n");
	});

	test("closes an unmatched quote at the end of its paragraph without adding a mark", () => {
		expect(renderBlocks("\"The first paragraph.\n\n\"The last.\"")).toEqual([
			"<p><span class=\"prose-dialogue\">“The first paragraph.</span></p>\n",
			"<p><span class=\"prose-dialogue\">“The last.”</span></p>\n",
		]);
	});

	test("closes an unmatched quote before the emphasis that contains it", () => {
		expect(render("*she whispers \"run* now")).toBe(
			"<p><em>she whispers <span class=\"prose-dialogue\">“run</span></em> now</p>\n",
		);
	});

	test("leaves quotes that cannot open or close as text", () => {
		expect(render("a 6\"2 board and 2 * 3")).toBe("<p>a 6&quot;2 board and 2 * 3</p>\n");
	});

	test("escapes raw HTML", () => {
		expect(render("<Oh, right.>")).toBe("<p>&lt;Oh, right.&gt;</p>\n");
	});

	test("treats a rule under a paragraph as a scene break and indentation as prose", () => {
		expect(renderBlocks("Scene one.\n---\n    Indented.")).toEqual([
			"<p>Scene one.</p>\n",
			"<hr>\n",
			"<p>Indented.</p>\n",
		]);
	});

	test("splits top-level blocks and keeps single line breaks", () => {
		expect(renderBlocks("> Air Groove: It's 11.\n> Where are you?\n\n- one")).toEqual([
			"<blockquote>\n<p>Air Groove: It’s 11.<br>\nWhere are you?</p>\n</blockquote>\n",
			"<ul>\n<li>one</li>\n</ul>\n",
		]);
	});
});

describe("revealedLength", () => {
	const sentence = "She counted the moves again, slower this time, as if the board might change its mind. ";

	test("holds back a short paragraph until the next block starts", () => {
		expect(revealedLength("Done.\n\nStill writ")).toBe("Done.\n\n".length);
		expect(revealedLength("Done.\n\nStill writing.\n\nN")).toBe("Done.\n\nStill writing.\n\n".length);
	});

	test("reveals the opening sentence as soon as it ends", () => {
		expect(revealedLength(`${sentence}She`)).toBe(sentence.length - 1);
	});

	test("releases a long paragraph at the latest sentence end each time a chunk has streamed", () => {
		const text = sentence.repeat(8);
		expect(revealedLength(text.slice(0, sentence.length + 298))).toBe(sentence.length - 1);
		expect(revealedLength(text.slice(0, sentence.length + 300))).toBe(sentence.length * 4 - 1);
		expect(revealedLength(text)).toBe(sentence.length * 7 - 1);
	});

	test("ends a CJK sentence at its full stop", () => {
		const pair = "灯りが消えた。誰も動かなかった。";
		expect(revealedLength(pair.repeat(12))).toBe(pair.length * 4 + "灯りが消えた。".length);
	});

	test("shows every finished sentence once the stream stalls", () => {
		expect(revealedLength("A lantern dims. ")).toBe(0);
		expect(revealedLength("A lantern dims. ", true)).toBe("A lantern dims.".length);
		expect(revealedLength("Done.\n\nA second paragraph waits here.", true)).toBe("Done.\n\nA second paragraph waits here.".length);
		expect(revealedLength("A lantern dims. The door", true)).toBe("A lantern dims.".length);
	});

	test("a later stall keeps what an earlier one showed while the text extends it", () => {
		const first = settledFloor("Wait...", "");
		expect(first).toBe("Wait...");
		expect(settledFloor("Wait...what", first)).toBe("Wait...");
		expect(settledFloor("Gone.", first)).toBe("Gone.");
	});

	test("never takes back revealed text as the stream grows", () => {
		const text = `${sentence.repeat(5)}\n\n"Short." ${sentence.repeat(9)}\n\nEnd.`;
		const lengths = [...text].map((_, index) => revealedLength(text.slice(0, index + 1)));
		expect(lengths).toEqual(lengths.toSorted((a, b) => a - b));
	});
});
