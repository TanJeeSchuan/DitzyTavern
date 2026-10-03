import type { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { readImage } from "../image";
import { imageParams } from "../../shared/contract/image";
import { notFoundOutcome } from "../../shared/contract/outcomes";

export const createImageRoutes = (database: Database) =>
	new Elysia().get(
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
