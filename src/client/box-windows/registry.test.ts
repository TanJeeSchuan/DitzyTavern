import { expect, test } from "bun:test";
import { addBoxClients, boxVersionsBuilt, chatBoxClient, loadBoxVersions, loadedBoxes } from "./registry";
import tipJar from "../../../e2e/fixtures/boxes/tip-jar-sandboxed/descriptor.json";
import { installBoxes, installedBoxes } from "../../shared/contract/box";

// @approved
//  A Chat refreshed from another tab can pin a Box this client's catalog has
// never listed. Counting that pin as built would skip loading it, leaving the
// Box's windows and Move chips missing until a reload.
test("a pin for a Box missing from this client's catalog is not built", () => {
	expect(boxVersionsBuilt({ boxVersions: { "authored-new": "c71e" } })).toBe(false);
	expect(boxVersionsBuilt({ boxVersions: {} })).toBe(true);
});

// @approved
//  A version built for a Chat pinned to it while another was latest was
// cached with latest's metadata; made latest again, it kept that label.
test("an earlier version made latest again lists its own label, keeping the client it was built with", async () => {
	const [v1, v2] = ["1".repeat(64), "2".repeat(64)];
	const descriptor = (label: string) => ({ ...tipJar, id: "jar", label });
	let listing = [{ id: "jar", label: "New", summary: "Counts tips.", instructions: "", sandboxed: descriptor("New"), version: v2 }];
	const original = globalThis.fetch;
	// The catalog this test lists replaces the shared registry, which the server tests in this process read; it is put back after.
	const shared = [...installedBoxes().values()];
	globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
		const path = new URL(String(input), "http://localhost").pathname;
		return path === "/api/boxes" ? Response.json(listing) : Response.json({ sandboxed: descriptor("Old") });
	}, { preconnect() {} });
	try {
		await loadBoxVersions({ boxVersions: { jar: v1 } });
		const client = chatBoxClient({ boxVersions: { jar: v1 } }, "jar");
		listing = [{ ...listing[0]!, label: "Old", sandboxed: descriptor("Old"), version: v1 }]; // @approved The listing has its one Box.
		await addBoxClients();
		expect(loadedBoxes().get("jar")?.metadata.label).toBe("Old");
		expect(chatBoxClient({ boxVersions: { jar: v1 } }, "jar")).toBe(client);
	} finally {
		globalThis.fetch = original;
		installBoxes(shared);
	}
});
