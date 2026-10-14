import { describe, expect, test } from "bun:test";
import { gifFixture, jpegFixture, webpFixture } from "./image-fixtures";
import { ingestImage } from "./ingest";

const includes = (haystack: Uint8Array, needle: string) => Buffer.from(haystack).includes(Buffer.from(needle, "latin1"));

describe("Image ingest", () => {
	test("strips JPEG GPS EXIF while keeping every other byte", async () => {
		const image = await ingestImage(jpegFixture({ gps: true }));
		expect(includes(image.bytes, "GPS")).toBe(false);
		expect(Buffer.compare(image.bytes, jpegFixture())).toBe(0);
		expect(image).toMatchObject({ mediaType: "image/jpeg", width: 5, height: 4 });
	});

	test("strips WebP XMP while keeping the pixel chunk", async () => {
		const image = await ingestImage(webpFixture({ xmp: true }));
		expect(includes(image.bytes, "xmpmeta")).toBe(false);
		expect(Buffer.from(image.bytes).includes(Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00, 0x11, 0x22, 0x33]))).toBe(true);
		expect(image).toMatchObject({ mediaType: "image/webp", width: 6, height: 4 });
	});

	test("keeps every frame of an animated GIF", async () => {
		const image = await ingestImage(gifFixture({ comment: "made-at-home" }));
		expect(includes(image.bytes, "made-at-home")).toBe(false);
		expect(Buffer.compare(image.bytes, gifFixture())).toBe(0);
		expect(image).toMatchObject({ mediaType: "image/gif", width: 2, height: 2 });
	});
});
