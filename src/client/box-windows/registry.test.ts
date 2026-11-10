import { expect, test } from "bun:test";
import { addBoxClients, boxVersionsBuilt, chatBoxClient, loadBoxVersions, loadedBoxes } from "./registry";
import tipJar from "../../../e2e/fixtures/boxes/tip-jar-sandboxed/descriptor.json";

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
	}
});

// @approved
//  The server parses a delegating Box's requests by the tag it loaded, and
// the client lifts them by the tag its module declares; a module that
// disagrees would leave every request as raw markup in the story.
test("a client module whose delegate differs from the server's listing is refused", async () => {
	const client = new URL("../../../e2e/fixtures/boxes/tip-jar/client.tsx", import.meta.url).href;
	const listing = [{ id: "tip-jar", label: "Tip Jar", summary: "", instructions: "", client, delegate: { tag: "jar", summary: "", description: "", off: "" } }];
	const original = globalThis.fetch;
	globalThis.fetch = Object.assign(async () => Response.json(listing), { preconnect() {} });
	try {
		await addBoxClients();
		expect(loadedBoxes().get("tip-jar")).toMatchObject({ failure: "Its client module delegates no tag, but the server loaded it delegating jar." });
	} finally {
		globalThis.fetch = original;
	}
});
