# Sandboxed Box UI isolation

Research snapshot: 2026-11-03, Bun 1.4.4, Playwright's Chromium and Firefox builds on Linux x86_64. Probe scripts lived in `.scratch/` and are summarized here. This note explains why ticket 01 runs guest UI code in a Worker rather than in a sandboxed iframe page, and records the host-side build risks that ticket 02c addresses.

## A scripted iframe cannot be kept off the network

Ticket 01 originally ran guest `ui.html` as the document of an iframe with `sandbox="allow-scripts"` (opaque origin) and a CSP built from `default-src 'none'`. The implementer found that a script in that document can still send data out:

| Probe | Result (Chromium) |
|---|---|
| `new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:<port>' }] })`, then `createOffer` | 3 STUN UDP packets reached a local socket |
| Same, with CSP `webrtc 'block'` added | `Unrecognized Content-Security-Policy directive 'webrtc'`; 3 packets again |

No CSP directive that Chromium supports governs WebRTC. Deleting `RTCPeerConnection` before guest code runs is not a boundary: a script can create an `about:blank` iframe and use that realm's copy (inference, not probed), and every other missed API is another hole.

## Guest code in a Worker inside the frame

Probe layout: the app page embeds a `sandbox="allow-scripts"` iframe whose document runs only host code under `default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:`. That host script creates a dedicated Worker from a blob of the guest code. The Worker inherits the frame's policy and opaque origin.

| Escape attempt from the Worker | Chromium | Firefox |
|---|---|---|
| `typeof RTCPeerConnection` / `webkitRTCPeerConnection` | undefined | undefined |
| `fetch` (absolute and relative) | blocked | blocked |
| `WebSocket`, `EventSource` | blocked | blocked |
| `importScripts` | blocked | blocked |
| Nested Worker from URL | SecurityError | created, its load blocked |
| Nested blob Worker's `fetch` | blocked | blocked |
| `FontFace` with a URL | blocked | blocked |
| `WebTransport` | undefined | blocked |
| `navigator.sendBeacon` | undefined | undefined |
| `indexedDB.open` | SecurityError | SecurityError |
| `OffscreenCanvas.getContext('2d')` | works | works |
| Requests reaching the server / UDP packets | 0 / 0 | 0 / 0 |

WebGL could not be tested on this host: headless Chromium (including SwiftShader flags) and Firefox both fail to create any WebGL context, even on a plain page. In the T3 app on the user's machine, the same sandbox (srcdoc frame, `default-src 'none'`, blob Worker) rendered a three.js r170 scene to an OffscreenCanvas with WebGL2, reported `fetch` blocked and `RTCPeerConnection` undefined. The trusted outer page fetched three.js and handed its source into the frame.

What still needs care, because the frame document has scripts: guest markup rendered into the frame must not run code or navigate. Sanitize it (no script, no event-handler attributes, no `javascript:` URLs, no `href`/`action`/`formaction`/`xlink:href`, no `meta`), keep `'unsafe-inline'` out of `script-src` (host script by nonce only), and keep the app page's `frame-src` limited to the frame route as a backstop.

## Install-time bundling runs untrusted code unless told not to

Letting a sandboxed Box import npm packages means the host builds guest source. Probe: a guest `ui.js` containing `import { pwn } from "./evil.ts" with { type: "macro" }`, where `pwn` writes a file.

| Build | Macro ran on the host? |
|---|---|
| `Bun.build({ entrypoints })` (default) | **yes**, file written |
| `Bun.build({ ..., macros: false })` | no, "Macros are disabled" |
| `bun build --no-macros` | no |

Other host-side risks of the same kind (inference): package lifecycle scripts during install (use `--ignore-scripts`), a guest `bunfig.toml` or `.npmrc` changing the registry or preloading code (the host writes `package.json` itself and ignores guest config), and imports that resolve outside the Box (`import env from "../../../.env" with { type: "text" }` would put host secrets into the bundle; confine resolution with a plugin).
