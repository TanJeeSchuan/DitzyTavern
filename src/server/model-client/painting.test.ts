import { expect, test } from "bun:test";
import { blankConnectionProfileDraft } from "../../shared/contract/connection-settings";
import { formatImageReference } from "../../shared/image-reference";
import { pngFixture, jpegFixture } from "../image/image-fixtures";
import { paintImage } from "./painting";

test("painting sends anchors, ordered reference Images and the chosen shape to OpenRouter", async () => {
	const map = pngFixture();
	const coat = jpegFixture();
	const pictures = new Map([["a".repeat(64), { bytes: map, mediaType: "image/png" }], ["b".repeat(64), { bytes: coat, mediaType: "image/jpeg" }]]);
	const result = await paintImage({
		profile: { ...blankConnectionProfileDraft, apiFormat: "images", adapter: "openrouter", requestUrl: "https://example.com/api/v1/" },
		modelId: "test/painter", secrets: { credential: "secret", headers: { "X-Custom": "yes" } },
		brief: `Paint ${formatImageReference("coat", "b".repeat(64))} beside ${formatImageReference("map", "a".repeat(64))}.`,
		aspectRatio: "3:4", loadImage: (hash) => pictures.get(hash),
		fetch: async (url, init) => {
			expect(String(url)).toBe("https://example.com/api/v1/images");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
			expect(new Headers(init?.headers).get("x-custom")).toBe("yes");
			expect(init?.redirect).toBe("error");
			expect(JSON.parse(String(init?.body))).toEqual({ model: "test/painter", prompt: "Paint [Image: coat] beside [Image: map].", n: 1, aspect_ratio: "3:4", input_references: [
				{ type: "image_url", image_url: { url: `data:image/jpeg;base64,${coat.toString("base64")}` } },
				{ type: "image_url", image_url: { url: `data:image/png;base64,${map.toString("base64")}` } },
			] });
			return Response.json({ data: [{ b64_json: map.toString("base64") }] });
		},
	});
	expect(Buffer.from(result)).toEqual(map);
});
