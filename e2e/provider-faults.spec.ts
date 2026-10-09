import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, send, story } from "./fixtures";

const setInactivityTimeout = async (request: APIRequestContext, timeoutMs: number) => {
	const settings = await (await request.get("/api/connection-settings")).json();
	const { id, discoveryCatalog: _catalog, credentialConfigured: _credential, headers: _headers, ...draft } = settings.profiles.find((profile: { apiFormat: string }) => profile.apiFormat === "chat-completions");
	await request.post("/api/connection-settings/commands", { data: { type: "apply-profile", expectedRevision: settings.revision, profileId: id, profile: { ...draft, timeoutMs } } });
};

const expectInterrupted = async (page: Page, cause: string) => {
	const reply = story(page).locator("article").last();
	await expect(page.getByRole("button", { name: "Generate Variant" })).toBeVisible();
	await expect(reply.getByText("Then the")).toBeVisible();
	await expect(reply.getByRole("button", { name: "Continue as Theodora Kline" })).toBeVisible();
	await reply.hover();
	await reply.getByRole("button", { name: "Details" }).click();
	const details = page.getByRole("complementary", { name: "Generation details" });
	await expect(details.getByRole("definition").filter({ hasText: new RegExp(`^${cause}$`) })).toBeVisible();
};

test("a stalled stream is interrupted by the inactivity timeout and keeps its partial reply", async ({ page, request, llm }) => {
	await setInactivityTimeout(request, 1_000);
	await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "Then the"], hold: true });
	await page.goto("/");
	await send(page, "Wait.");
	await expectInterrupted(page, "inactivity");
});

test("a stream that drops without finishing is recorded as a provider interruption", async ({ page, llm }) => {
	await llm.chat({ chunks: ["The tide turns against the pier.\n\n", "Then the"], truncate: true });
	await page.goto("/");
	await send(page, "Wait.");
	await expectInterrupted(page, "provider");
});
