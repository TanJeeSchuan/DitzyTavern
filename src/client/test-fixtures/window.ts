// @approved
//  Client modules read `window.location` at import (the Eden client), and Bun caches a failed module
// evaluation for every later importer, so the stub must exist before any test file loads.
Object.defineProperty(globalThis, "window", {
	configurable: true,
	writable: true,
	value: { location: { origin: "http://localhost" }, addEventListener() {}, removeEventListener() {} },
});
