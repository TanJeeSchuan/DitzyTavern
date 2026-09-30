import { describe, expect, test } from "bun:test";
import { renderBlocks, revealedLength } from "./prose";

const render = (text: string) => renderBlocks(text).join("");

describe("renderBlocks", () => {
	test("wraps dialogue with its quote marks and nests emphasis inside it", () => {
		expect(render("\"I don't *think* I'm in charge.\" He left.")).toBe(
			"<p><span class=\"prose-dialogue\">&quot;I don't <em>think</em> I'm in charge.&quot;</span> He left.</p>\n",
		);
	});

	test("matches curly quotes", () => {
		expect(render("She said “hi”.")).toBe("<p>She said <span class=\"prose-dialogue\">“hi”</span>.</p>\n");
	});

	test("closes an unmatched quote at the end of its paragraph without adding a mark", () => {
		expect(renderBlocks("\"The first paragraph.\n\n\"The last.\"")).toEqual([
			"<p><span class=\"prose-dialogue\">&quot;The first paragraph.</span></p>\n",
			"<p><span class=\"prose-dialogue\">&quot;The last.&quot;</span></p>\n",
		]);
	});

	test("closes an unmatched quote before the emphasis that contains it", () => {
		expect(render("*she whispers \"run* now")).toBe(
			"<p><em>she whispers <span class=\"prose-dialogue\">&quot;run</span></em> now</p>\n",
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
			"<blockquote>\n<p>Air Groove: It's 11.<br>\nWhere are you?</p>\n</blockquote>\n",
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

	test("releases a long paragraph at the first sentence end past each chunk", () => {
		const text = sentence.repeat(8);
		const released = revealedLength(text);
		expect(released % sentence.length).toBe(sentence.length - 1);
		expect(released).toBeGreaterThanOrEqual(300);
		expect(text.length - released).toBeLessThan(300 + sentence.length);
	});
});
