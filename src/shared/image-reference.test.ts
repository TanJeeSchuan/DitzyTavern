import { describe, expect, test } from "bun:test";
import { formatImageReference, imageHashes, imageReferenceAt, jsonImageHashes, parseImageReferences, projectImageAnchors, sanitizeImageName } from "./image-reference";

const hash = "a".repeat(64);
const other = "b".repeat(64);

describe("Image References", () => {
	test("finds every reference with its position, name, and hash", () => {
		const text = `Look ![the map](image:${hash}) and *then* ![portrait](image:${other}).`;
		const [first, second] = parseImageReferences(text);
		expect(first).toMatchObject({ name: "the map", hash });
		expect(text.slice(first!.start, first!.end)).toBe(`![the map](image:${hash})`);
		expect(second).toMatchObject({ name: "portrait", hash: other });
	});

	test("ignores every other image URL and malformed hash", () => {
		const text = `![a](https://example.com/a.png) ![b](image:abc) ![c](image:${"A".repeat(64)}) ![](image:${hash})`;
		expect(parseImageReferences(text)).toEqual([]);
	});

	test("sanitizes names so they cannot break the syntax", () => {
		expect(sanitizeImageName("a[b]c\\d\ne")).toBe("a b c d e");
		expect(sanitizeImageName("  spaced   out  ")).toBe("spaced out");
		expect(sanitizeImageName("")).toBe("image");
		expect(sanitizeImageName("[]")).toBe("image");
		expect(sanitizeImageName("x".repeat(500))).toHaveLength(80);
	});

	test("a formatted reference parses back to its sanitized name and hash", () => {
		const text = formatImageReference("holiday [2019]\n(final).png", hash);
		expect(parseImageReferences(text)).toMatchObject([{ name: "holiday 2019 (final).png", hash }]);
	});

	test("projects references to anchors and leaves other text untouched", () => {
		const text = `![the map](image:${hash})\n*waves* ![x](http://e/x.png) "hi"`;
		expect(projectImageAnchors(text)).toBe('[Image: the map]\n*waves* ![x](http://e/x.png) "hi"');
	});

	test("lists the hashes a text references", () => {
		expect(imageHashes(`![a](image:${hash}) ![b](image:${hash}) ![c](image:${other})`)).toEqual([hash, hash, other]);
	});
});

describe("imageReferenceAt", () => {
	test("matches only a Reference that starts at the position", () => {
		const text = `ab ![map](image:${hash})`;
		expect(imageReferenceAt(text, 3)).toMatchObject({ name: "map", hash, start: 3 });
		expect(imageReferenceAt(text, 0)).toBeUndefined();
	});
});

describe("JSON-held References", () => {
	test("finds hashes through JSON escaping, including names with quotes", () => {
		const json = JSON.stringify([{ name: "outfit", operation: "set", value: `a "quoted" ![the "red" coat](image:${hash})` }]);
		expect(jsonImageHashes(json)).toEqual([hash]);
	});

	test("ignores a label the text parser would not accept", () => {
		expect(jsonImageHashes(JSON.stringify(`![a[b](image:${hash})`))).toEqual([]);
	});
});
