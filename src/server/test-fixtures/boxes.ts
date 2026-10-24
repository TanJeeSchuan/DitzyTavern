import { builtInBoxes, loadBoxes } from "../box/registry";

// @approved
//  Every test reads Boxes through the registry, as the server does once
// startup loads it, so the test preload loads the built-in Boxes first.
await loadBoxes([builtInBoxes]);
