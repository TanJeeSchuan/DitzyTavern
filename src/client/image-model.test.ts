import { afterEach, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { withDeadline } from "../shared/test-fixtures/deadline";
import { flushHook, renderHook } from "./test-fixtures/render-hook";
import { modelSelectionKey, useImageModel } from "./model-selection-client";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("an older Image Model read started during a save cannot replace the committed model", async () => {
	const old = { revision: 1, profileId: 1, model: "old-painter" };
	const selected = { ...old, revision: 2, model: "new-painter" };
	const client = new QueryClient();
	const key = modelSelectionKey("image-model");
	client.setQueryData(key, old);
	const posting = Promise.withResolvers<void>();
	const post = Promise.withResolvers<void>();
	const reading = Promise.withResolvers<void>();
	const read = Promise.withResolvers<void>();
	let holdRead = false;
	globalThis.fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
		if (init?.method === "POST") {
			posting.resolve();
			await withDeadline(post.promise, "model write release");
			return Response.json({ outcome: "applied", settings: selected });
		}
		if (holdRead) {
			reading.resolve();
			await withDeadline(read.promise, "stale model read release");
		}
		return Response.json(old);
	}, { preconnect: () => {} });

	const model = await renderHook(useImageModel, client);
	await model.act(async () => { model.current.select(1, selected.model); });
	try {
		await withDeadline(posting.promise, "model write");
		await flushHook();
		expect(model.current.pending).toBe(true);
		holdRead = true;
		await model.act(async () => { void client.refetchQueries({ queryKey: key }); });
		await withDeadline(reading.promise, "stale model read");
		await model.act(async () => { post.resolve(); });
		await flushHook();
		expect(model.current.selected).toEqual(selected);
		await model.act(async () => { read.resolve(); });
		await flushHook();
		expect(model.current.selected).toEqual(selected);
		expect(model.current.pending).toBe(false);
	} finally { post.resolve(); read.resolve(); }
});
