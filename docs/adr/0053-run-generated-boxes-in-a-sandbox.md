# Run generated Boxes in a sandbox

A plugin Box is trusted code: its `server.ts` runs in the server process with the database, and its `client.js` runs in the app page. Creator Mode (ticket 03) will have a model write Boxes, so the host needs a second kind whose code reaches nothing but what the host hands it.

A sandboxed Box is a folder holding `descriptor.json`, `logic.js` and `ui.js`, plus an optional `ui.css`, loaded with no build. The folder sits where a trusted plugin does, `data/boxes/<id>/`; what separates the kinds is the files, and a folder holding both `server.ts` and `logic.js` is refused. Each sandboxed Box loads under its own id, so its lifecycle instance, seed, preset block, traces and schema checks are a Box's like any other.

- **Descriptor.** `descriptor.json` declares a descriptor's fields as JSON: each schema as the JSON a TypeBox schema serializes to, limited to the forms the Fork walker handles and the primitives and literals inside them, and the Move chip label as a `{key}` template. The server and the client rebuild the same TypeBox descriptor from it, so every host check reads it as it reads a built-in's.
- **Logic.** `logic.js`, an ES module with no imports, runs in QuickJS in the server process, called synchronously, so capture and window reads keep calling hooks inside their SQLite read transaction. Values cross as JSON strings and outcomes as a JSON envelope. Each Box gets its own instance of the compiled QuickJS module on a `WebAssembly.Memory` capped at 64 MiB: QuickJS's own memory limit did not bound this build's heap, which grew past 2 GiB of strings, arrays or ArrayBuffers under a 64 MiB limit. Each entry into the guest has a 100 ms deadline, and each call carries at most 4 MiB of JSON each way. A sandboxed fold receives the Selected path's effective records in one call. Logic has no clock and no `Math.random`.
- **UI.** Guest UI code never runs in a document: a scripted sandboxed document reaches the network through WebRTC, and no CSP directive stops it ([research](../research/sandboxed-box-ui-isolation.md)). The window mounts a `sandbox="allow-scripts"` frame served by `/api/box-frame` under a nonce policy built from `default-src 'none'`; its host script starts the guest's `ui.js` in a blob Worker, which inherits that policy and opaque origin and has no DOM, fetch, socket or WebRTC. The guest renders by sending markup, which the frame sanitizes with DOMPurify, and hears `data-on` events back. The app talks to the frame over one `MessagePort` per frame load, and the app page's `frame-src` admits only the frame route.

## Considered Options

- One `sandbox` Box hosting every generated Box: rejected because lifecycle, seeds, preset blocks, traces and schema checks are per Box id.
- Guest UI as the frame's document: rejected for the WebRTC leak above.
- `quickjs-emscripten`'s asyncify build: rejected because hooks are synchronous and `advance` only needs a promise pumped to settlement.
- One QuickJS module shared by every Box, bounded by `setMemoryLimit`: rejected because that limit did not hold.
