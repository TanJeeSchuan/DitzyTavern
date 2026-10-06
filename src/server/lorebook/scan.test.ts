import { describe, expect, test } from "bun:test";
import { formatImageReference } from "../../shared/image-reference";
import { captureLoreScanWindow } from "./scan";

const messages = [1, 2, 3, 4, 5].map((id) => ({ id, content: `Message ${id}` }));

describe("Lore Scan Window", () => {
	test("defaults to four individual Messages", () => {
		expect(captureLoreScanWindow({ messages }).map((message) => message.id)).toEqual([2, 3, 4, 5]);
	});

	test("includes pending Send text in the same bounded window", () => {
		expect(captureLoreScanWindow({ messages: messages.slice(0, 3), pendingHumanText: "Pending" })).toEqual([
		{ id: 1, content: "Message 1", pending: false },
		{ id: 2, content: "Message 2", pending: false },
		{ id: 3, content: "Message 3", pending: false },
		{ id: null, content: "Pending", pending: true },
	]);
	});

	test("excludes a Sibling target and every later Message before applying depth", () => {
		expect(captureLoreScanWindow({ messages, beforeMessageId: 4 }).map((message) => message.id)).toEqual([1, 2, 3]);
		expect(captureLoreScanWindow({ messages, beforeMessageId: 4, pendingHumanText: "ignored" }).map((message) => message.id)).toEqual([1, 2, 3]);
	});

	test("rejects invalid depth and does not invent a target boundary", () => {
		expect(() => captureLoreScanWindow({ messages, depth: -1 })).toThrow("non-negative");
		expect(captureLoreScanWindow({ messages, beforeMessageId: 999 }).map((message) => message.id)).toEqual([2, 3, 4, 5]);
	});

	test("does not scan when the configured depth is zero", () => {
		expect(captureLoreScanWindow({ messages, pendingHumanText: "Pending", depth: 0 })).toEqual([]);
	});

	test("reads Images only as Image Anchors, never their hash", () => {
		const hash = "e".repeat(64);
		const token = formatImageReference("the map", hash);
		const window = captureLoreScanWindow({ messages: [{ id: 1, content: `See ${token}.` }], pendingHumanText: `Then ${token}` });
		expect(window.map((message) => message.content)).toEqual(["See [Image: the map].", "Then [Image: the map]"]);
	});
});
