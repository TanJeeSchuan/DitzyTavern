import type { APIRequestContext } from "@playwright/test";
import { test, expect, enableDecisionModels, send, story } from "./fixtures";

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
	await enableDecisionModels(request);
};

const sendWithLore = async (page: import("@playwright/test").Page, llm: import("./harness").E2eServer) => {
	await page.goto("/");
	await send(page, "I was home all night, nowhere near the lighthouse.");
	await expect(story(page).getByText("The keeper says nothing.")).toBeVisible();
	const [call] = (await llm.log()).calls.filter((entry) => entry.kind === "chat");
	return JSON.stringify(call.body.messages);
};

test("Lore activates by keyword and by Decision Model judgments", async ({ page, request, llm }) => {
	await attachLorebook(request);
	await llm.decisions(
		{ match: ["somewhere they were not"], answer: { type: "noul", noul: 0.92 } },
		{ match: ["A dragon appears"], answer: { type: "noul", noul: 0.04 } },
	);
	await llm.chat({ chunks: ["The keeper says nothing."] });
	const prompt = await sendWithLore(page, llm);
	expect(prompt).toContain("LORE-LIGHTHOUSE");
	expect(prompt).toContain("LORE-ALIBI");
	expect(prompt).not.toContain("LORE-DRAGON");
	const [decisionCall] = (await llm.log()).calls.filter((entry) => entry.kind === "decision");
	expect(JSON.stringify(decisionCall.body.state)).toContain("I was home all night");
});

test("Lore falls back to keywords when the Decision Model is unreachable", async ({ page, request, llm }) => {
	await attachLorebook(request);
	await llm.decisions({ match: [], status: 502 });
	await llm.chat({ chunks: ["The keeper says nothing."] });
	const prompt = await sendWithLore(page, llm);
	expect(prompt).toContain("LORE-LIGHTHOUSE");
	expect(prompt).not.toContain("LORE-ALIBI");
});

const importBook = async (request: APIRequestContext, name: string) => {
	// SAFETY: these tests address only the imported book's id; the rest of the import response is out of their contract.
	const { book } = (await (await request.post("/api/lorebooks/import", { data: { name, description: "", entries: [] } })).json()) as { book: { id: number } };
	return book;
};

// Another surface edits the Chat while a Lore surface holds its stale revision.
const renameChat = async (request: APIRequestContext, conversationId: number) => {
	const { revision } = await (await request.get(`/api/conversations/${conversationId}`)).json();
	await request.post(`/api/conversations/${conversationId}/commands`, { data: { expectedRevision: revision, action: { type: "rename-conversation", name: "The Renamed House" } } });
};

test.describe("stale Lore conflicts reload their surface", () => {
	// The deliberate 409 conflict responses log one browser console error each.
	test.use({ allowedBrowserErrors: /status of 409/ });

	test("a stale Chat Lore conflict reloads the panel and an unchanged retry applies", async ({ page, request }) => {
		const { activeChatId } = await (await request.get("/api/workspace")).json();
		await importBook(request, "Harbor");
		await page.goto("/");
		await page.getByRole("button", { name: "Lorebooks" }).click();
		await page.getByRole("button", { name: "Attach Harbor to this Chat" }).click();
		await expect(page.getByRole("button", { name: "Detach Harbor" })).toBeVisible();

		await renameChat(request, activeChatId);
		await page.getByRole("button", { name: "Detach Harbor" }).click();
		await expect(page.getByText("Lorebook attachment settings changed elsewhere.")).toBeVisible();
		// The conflict refetched the attachment state, so the same unchanged action
		// retried succeeds without leaving the panel.
		await page.getByRole("button", { name: "Detach Harbor" }).click();
		await expect(page.getByText("No Lorebooks are attached to this Chat.")).toBeVisible();
	});

	test("a stale Participant Lorebook conflict reloads the editor and an unchanged retry applies", async ({ page, request }) => {
		const { activeChatId } = await (await request.get("/api/workspace")).json();
		await importBook(request, "Harbor");
		await importBook(request, "Tide log");
		await page.goto("/");
		await page.getByRole("button", { name: "Characters" }).click();
		// The Cast row button precedes its row menu, so first() opens the editor.
		await page.getByRole("button", { name: /Theodora Kline maps coastlines/ }).first().click();
		await page.getByRole("combobox", { name: "Lorebook to attach" }).click();
		await page.getByRole("option", { name: "Harbor" }).click();
		await page.getByRole("button", { name: "Attach", exact: true }).click();
		await expect(page.getByText("Harbor · cast · Enabled")).toBeVisible();

		await renameChat(request, activeChatId);
		await page.getByRole("combobox", { name: "Lorebook to attach" }).click();
		await page.getByRole("option", { name: "Tide log" }).click();
		await page.getByRole("button", { name: "Attach", exact: true }).click();
		await expect(page.getByText("Lorebook attachment could not be saved.")).toBeVisible();
		// The conflict reloaded the editor's owner state, so the same unchanged
		// action retried succeeds while the editor stays open.
		await page.getByRole("button", { name: "Attach", exact: true }).click();
		await expect(page.getByText("Tide log · cast · Enabled")).toBeVisible();
		await expect(page.getByText("Harbor · cast · Enabled")).toBeVisible();
	});
});
