import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { InvalidImageError, readImage, uploadImage } from "../image";
import { imageParams, imageUploadBody, imageUploadResponse } from "../../shared/contract/image";
import { invalidOutcome, notFoundOutcome } from "../../shared/contract/outcomes";

export const createImageRoutes = (database: Database) =>
	new Elysia().post("/api/images", async ({ body, status }) => {
		try {
			return await uploadImage(database, Buffer.from(body.data, "base64"));
		} catch (error) {
			if (error instanceof InvalidImageError) return status(422, { outcome: "invalid" as const, reason: error.message });
			throw error;
		}
	}, { body: imageUploadBody, response: { 200: imageUploadResponse, 422: invalidOutcome } }).get(
		"/api/images/:hash",
		({ params, status }) => {
			const image = readImage(drizzle(database), params.hash);
			if (image === undefined) return status(404, { outcome: "not-found" as const });
			return new Response(new Uint8Array(image.bytes), {
				headers: { "content-type": image.media_type, "cache-control": "public, max-age=31536000, immutable" },
			});
		},
		{
			params: imageParams,
			response: { 404: notFoundOutcome },
		},
	);
