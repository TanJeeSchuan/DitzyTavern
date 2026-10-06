import type { APIRequestContext } from "@playwright/test";
import { test, expect, enableJev, story } from "./fixtures";

const entry = (title: string, content: string, keywords: string[], semanticTriggers: string[]) => ({
	title, content, keywords, semanticTriggers,
	matchOperator: "or", always: false, requireAny: [], requireAll: [], excludeAny: [], excludeAll: [],
	caseSensitive: false, wholeWord: true, keywordMode: "literal", regexFlags: "", priority: 0, enabled: true,
});

const attachLorebook = async (request: APIRequestContext) => {
	const { book } = await (await request.post("/api/lorebooks/import", { data: {
		name: "Observatory secrets", description: "",
		entries: [
			entry("Lighthouse", "LORE-LIGHTHOUSE: the lamp has been dark since spring.", ["lighthouse"], []),
			entry("Alibi", "LORE-ALIBI: nobody saw the night desk leave.", [], ["Someone claims to have been somewhere they were not"]),
			entry("Dragon", "LORE-DRAGON: a dragon sleeps under the dome.", [], ["A dragon appears"]),
		],
	} })).json();
	const { activeChatId } = await (await request.get("/api/workspace")).json();
	const { revision } = await (await request.get(`/api/lorebooks/attachments?conversationId=${activeChatId}`)).json();
	await request.post("/api/lorebooks/attachments/commands", { data: { type: "attach-chat", conversationId: activeChatId, bookId: book.id, expectedRevision: revision } });
	await enableJev(request);
};

const sendWithLore = async (page: import("@playwright/test").Page, llm: import("./harness").E2eServer) => {
	await page.goto("/");
	await page.getByRole("textbox", { name: "Message draft" }).fill("I was home all night, nowhere near the lighthouse.");
	await page.getByRole("button", { name: "Generate Variant" }).click();
	await page.getByRole("button", { name: "Send exact plan" }).click();
	await expect(story(page).getByText("The keeper says nothing.")).toBeVisible();
	const [call] = (await llm.log()).calls.filter((entry) => entry.kind === "chat");
	return JSON.stringify(call.body.messages);
};

test("Lore activates by keyword and by Jev-judged meaning", async ({ page, request, llm }) => {
	await attachLorebook(request);
	await llm.jev(
		{ match: ["somewhere they were not"], answer: { type: "noul", noul: 0.92 } },
		{ match: ["A dragon appears"], answer: { type: "noul", noul: 0.04 } },
	);
	await llm.chat({ chunks: ["The keeper says nothing."] });
	const prompt = await sendWithLore(page, llm);
	expect(prompt).toContain("LORE-LIGHTHOUSE");
	expect(prompt).toContain("LORE-ALIBI");
	expect(prompt).not.toContain("LORE-DRAGON");
	const [jevCall] = (await llm.log()).calls.filter((entry) => entry.kind === "jev");
	expect(JSON.stringify(jevCall.body.state)).toContain("I was home all night");
});

test("Lore falls back to keywords when Jev is unreachable", async ({ page, request, llm }) => {
	await attachLorebook(request);
	await llm.jev({ match: [], status: 502 });
	await llm.chat({ chunks: ["The keeper says nothing."] });
	const prompt = await sendWithLore(page, llm);
	expect(prompt).toContain("LORE-LIGHTHOUSE");
	expect(prompt).not.toContain("LORE-ALIBI");
});
