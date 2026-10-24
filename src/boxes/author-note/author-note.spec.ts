import { test, expect, send, story } from "../../../e2e/fixtures";
import { firstCall, isChatModelCall } from "../../../e2e/protocol";

test("writer saves an Author Note and sends it after history", async ({ page, llm }) => {
	await llm.chat({ chunks: ["Maren closes the door."] });
	await page.goto("/");
	await page.getByRole("button", { name: "Author Note", exact: true }).click();
	await page.getByRole("textbox", { name: "Author Note text" }).fill("Keep the room silent.");
	await page.getByRole("button", { name: "Save Author Note" }).click();
	await expect(page.getByRole("button", { name: "Save Author Note" })).toBeDisabled();
	await page.getByRole("button", { name: "Close Author Note" }).click();
	await send(page, "Close the door.");
	await expect(story(page).getByText("Maren closes the door.")).toBeVisible();
	const call = firstCall((await llm.log()).calls, isChatModelCall);
	const messages = call.body.messages;
	const history = messages.findIndex((message) => message.content.includes("Close the door."));
	expect(messages[history + 1]).toMatchObject({ role: "system", content: expect.stringContaining("Keep the room silent.") });
});
