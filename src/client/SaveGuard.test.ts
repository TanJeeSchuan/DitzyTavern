import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { renderHook } from "./test-fixtures/render-hook";
import { useSaveNavigation } from "./SaveGuard";

test("discarding edits when closing a Box keeps the open Definition draft", async () => {
	const hook = await renderHook(useSaveNavigation, new QueryClient());
	let name = "Edited Maren";
	let windowNote = "Edited note";
	let windowOpen = true;
	await hook.act(async () => {
		hook.current.registerSaveGuard({ dirty: true, discard: () => { name = "Maren"; } });
		hook.current.registerSaveGuard({ scope: "world-clock", dirty: true, discard: () => { windowNote = ""; } });
		hook.current.requestNavigation(() => { windowOpen = false; }, "world-clock");
	});
	expect(hook.current.dialogProps.open).toBe(true);
	await hook.act(async () => hook.current.dialogProps.onDiscard());
	expect([windowOpen, windowNote, name]).toEqual([false, "", "Edited Maren"]);
});
