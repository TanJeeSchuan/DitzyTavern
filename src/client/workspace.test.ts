import { describe, expect, test } from "bun:test";
import type { ChatSummary } from "./workspace";

Object.defineProperty(globalThis, "window", {
	configurable: true,
	// SAFETY: the test supplies the minimal browser location read by Eden.
	value: { location: { origin: "http://localhost" } } as Window,
});
const { resolveWorkspaceActiveChat } = await import("./workspace");

const chats: ChatSummary[] = [
	{ id: "1", title: "First Chat", updatedAt: "2024-01-01", castNames: [], excerpt: "" },
	{ id: "2", title: "Imported Chat", updatedAt: "2024-02-01", castNames: [], excerpt: "" },
	{ id: "3", title: "Latest Chat", updatedAt: "2024-03-01", castNames: [], excerpt: "" },
];

describe("preferred Chat workspace loading", () => {
	test("a present preferred Chat is selected over the authoritative active Chat", () => {
		const active = resolveWorkspaceActiveChat(chats, "3", "2");

		expect(active?.id).toBe("2");
		expect(active?.title).toBe("Imported Chat");
	});

	test("an absent preferred Chat falls back to the authoritative active Chat", () => {
		const active = resolveWorkspaceActiveChat(chats, "1", "999");

		expect(active?.id).toBe("1");
		expect(active?.title).toBe("First Chat");
	});

	test("a load without a preference keeps the authoritative active Chat", () => {
		const active = resolveWorkspaceActiveChat(chats, "3");

		expect(active?.id).toBe("3");
		expect(active?.title).toBe("Latest Chat");
	});
});
