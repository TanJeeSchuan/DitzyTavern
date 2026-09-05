import { describe, expect, test } from "bun:test";
import type { ConversationSummary } from "../conversation";
import { adoptConversationSummary } from "./conversation-session-state";

const summary = (id: number, revision: number) => {
	// SAFETY: The pure adoption helper reads only id and revision; the fixture deliberately supplies that tested boundary.
	return { id, revision } as ConversationSummary;
};

describe("adoptConversationSummary", () => {
	test("rejects snapshots for another chat", () => {
		const current = summary(1, 4);

		expect(adoptConversationSummary(current, summary(2, 99), 1)).toBe(current);
	});

	test("rejects older snapshots for the active chat", () => {
		const current = summary(1, 4);

		expect(adoptConversationSummary(current, summary(1, 3), 1)).toBe(current);
	});

	test("adopts a newer snapshot for the active chat", () => {
		const incoming = summary(1, 5);

		expect(adoptConversationSummary(summary(1, 4), incoming, 1)).toBe(incoming);
	});
});
