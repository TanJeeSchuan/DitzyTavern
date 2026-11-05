import { expect, test } from "bun:test";
import { boxVersionsBuilt } from "./registry";

// @approved
//  A Chat refreshed from another tab can pin a Box this client's catalog has
// never listed. Counting that pin as built would skip loading it, leaving the
// Box's windows and Move chips missing until a reload.
test("a pin for a Box missing from this client's catalog is not built", () => {
	expect(boxVersionsBuilt({ boxVersions: { "authored-new": "c71e" } })).toBe(false);
	expect(boxVersionsBuilt({ boxVersions: {} })).toBe(true);
});
