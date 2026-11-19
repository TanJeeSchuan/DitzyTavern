import { afterEach } from "bun:test";
import { builtInBoxes, installCatalog, loadBoxes } from "../box/registry";

// @approved
//  Every test reads Boxes through the registry, as the server does once
// startup loads it, so the test preload loads the built-in Boxes first.
// Tests share one process (`--no-isolate`). Republish the server catalog
// after a client test replaces it, or reload the built-ins if a test
// temporarily replaced the server catalog with loadTestBoxes.
await loadBoxes([builtInBoxes]);
let restoreBuiltIns = false;
afterEach(async () => {
	if (restoreBuiltIns) {
		restoreBuiltIns = false;
		await loadBoxes([builtInBoxes]);
	} else installCatalog();
});

export const loadTestBoxes = (folders: readonly string[]) => {
	restoreBuiltIns = true;
	return loadBoxes(folders);
};
