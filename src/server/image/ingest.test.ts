import { describe, expect, test } from "bun:test";
import { InvalidImageError } from "./errors";
import { gifFixture, jpegFixture, pngFixture, webpFixture } from "./image-fixtures";
import { ingestImage, MAX_IMAGE_BYTES } from "./ingest";

const includes = (haystack: Uint8Array, needle: string) => Buffer.from(haystack).includes(Buffer.from(needle, "latin1"));

describe("Image ingest", () => {
	test("strips JPEG GPS EXIF while keeping every other byte", async () => {
		const image = await ingestImage(jpegFixture({ gps: true }));
		expect(includes(image.bytes, "GPS")).toBe(false);
		expect(Buffer.compare(image.bytes, jpegFixture())).toBe(0);
		expect(image).toMatchObject({ mediaType: "image/jpeg", width: 5, height: 4 });
	});

	test("strips PNG tEXt card data while keeping the pixel chunks", async () => {
		const image = await ingestImage(pngFixture({ card: "secret-card" }));
		expect(includes(image.bytes, "secret-card")).toBe(false);
		expect(Buffer.compare(image.bytes, pngFixture())).toBe(0);
		expect(image).toMatchObject({ mediaType: "image/png", width: 3, height: 2 });
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

	test("hashes the stripped bytes, so metadata never changes identity", async () => {
		const [plain, tagged] = await Promise.all([ingestImage(pngFixture()), ingestImage(pngFixture({ card: "x" }))]);
		expect(tagged.hash).toBe(plain.hash);
		expect(plain.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	test("rejects unsupported content and oversized files", async () => {
		const unsupported = ingestImage(Buffer.from("BM not an accepted image"));
		await expect(unsupported).rejects.toBeInstanceOf(InvalidImageError);
		await expect(unsupported).rejects.toMatchObject({ reason: "unsupported-type" });
		await expect(ingestImage(Buffer.alloc(MAX_IMAGE_BYTES + 1))).rejects.toMatchObject({ reason: "too-large" });
	});
});
