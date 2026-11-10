import { afterEach } from "bun:test";
import { builtInBoxes, installCatalog, loadBoxes } from "../box/registry";

// @approved
//  Every test reads Boxes through the registry, as the server does once
// startup loads it, so the test preload loads the built-in Boxes first.
// Tests share one process (`--no-isolate`), and a client test that installs
// its own catalog replaces the shared registry the server tests read, so
// after every test the shared registry is rebuilt from the server's catalog,
// which it mirrors. A test that loads other Boxes into the server keeps them.
await loadBoxes([builtInBoxes]);
afterEach(installCatalog);
