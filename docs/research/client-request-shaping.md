# Client request shaping audit (2026-10-30)

Sources: three GPT 6.1 Terra (high) static audits (conversation path; libraries and settings; transport and assets), checked against the code and against live traffic. The live capture used headless Chromium against the dev instance on :3000, with the 409-message "Rulership chat". That instance runs the `integration-system-placement` worktree, not master. Every request in the capture was a GET.

## Measured baseline

Cold boot: 51 requests, 2.89 MB on the wire, no compression on any response.

| Payload | Raw | Brotli | Note |
|---|---|---|---|
| `index-*.js` (entry) | 885 KB | 229 KB | |
| `NumberControls-*.js` (shared UI chunk, modulepreloaded) | 534 KB | 143 KB | Radix/cmdk shared with the lazy `box-digest` chunk; eager either way |
| `index-*.css` | 187 KB | 26 KB | |
| `GET /conversations/3/history?page=1` (50 msgs, 118 variants) | 506 KB | 131 KB | 69% unselected variants, 36% reasoning |
| `GET /conversations/3/boxes/memory` (digest timeline) | **1.48 MB** | 235 KB | 409 passages, every passage's prose; polled every 2.5 s |
| `GET /conversations/3/boxes/world-clock`, `/mood` | 678 KB each | | same shape |
| Box `client.js` + `client.css` (7 Boxes) | ~205 KB | | `no-cache` with no validator: full re-download on every load |

The history page breaks down as: selected content 76 KB, selected reasoning 44 KB, unselected content 212 KB, unselected reasoning 138 KB. Reasoning renders collapsed (`src/client/story/StoryMessageView.tsx:309`).

Boot waterfall (ms from navigation, warm server):

```
162  GET /api/boxes
 └ 7 Box client.js → 8 /host/*.js revalidations → 6 Box client.css
242  GET /api/workspace                      (waits for every Box module)
 └ 351  /conversations/3, /history?page=1, /connection-settings, /connection-settings/presets
     └ 433  /conversations/3/generation-settings   (waits for the summary)
```

On localhost, the four serial levels cost ~270 ms. Through Cloudflare Access, each level costs a full round trip plus the Box downloads. On reload, hashed assets come from cache (0 bytes), but Box modules re-transfer in full, and the 8 `/host` chunks each take a 304 round trip.

## Opportunities, ranked by payoff ÷ effort

### 1. Box digest polling ships the whole transcript every 2.5 s (high payoff, S→M)

`src/client/box-windows/PassageTimeline.tsx:24` polls the full timeline every 2.5 s, or every 750 ms during catch-up. `useBoxStatus` (line 37) polls a second endpoint on top of that. Windows restore from localStorage (`useBoxWindows.ts`), so a Memory window left open starts this at boot. The response carries `content` for every passage (`src/server/box/digest.ts:326`) and refolds selected history on every read (`src/server/box/window.ts:18`).

With one Memory window open on this chat, that is **~35 MB/min idle and ~118 MB/min during catch-up**. The client also parses 1.5 MB of JSON every 2.5 s, which janks on phones.

- S: drop `content` from passages. The client already holds the history. If the timeline needs prose for passages outside the loaded history pages, fetch those by id.
- S: return a validator (`ETag: "<revision>:<digest-generation>:<catchUp progress>"`) and answer `304` before folding. The validator must cover digest writes that land after the conversation commit, plus in-memory catch-up progress, not just `revision`.
- S: don't mount `Status` for absent Boxes (`BoxManager.tsx:53`), and derive status from the open timeline instead of polling it separately.
- S: split Memory's allowance out of its 2.5 s poll (`src/boxes/memory/client-use-memories.ts:13`).

### 2. Send waits behind a full history refetch before it subscribes (high feel payoff, S, needs a check)

`finishStart` (`src/client/workspace/useAssemblyController.ts:148`) calls `generationStart.accepted` only after `refreshStory` resolves. `refreshStory` (`useConversationSession.ts:157`) runs a summary GET, then refetches every active history page, one after the other. The SSE subscription therefore starts after 2+ round trips and ≥500 KB per loaded page, so time-to-first-token pays for the whole transcript. The `@approved` comment says "the story refresh never blocks it"; the code awaits the refresh.

- S: call `accepted` immediately and run the refresh concurrently. First confirm the session runner has no dependency on the accepted variant being in history when it is reported, i.e. that it reconciles when history arrives.

### 3. Every mutation re-downloads every loaded history page (high, M)

`publishConversation` / `conversationQuery` (`src/client/conversation-query.ts:28,42`) invalidate all `["conversation-history", id]` whenever the revision advances. Swipe select, edit, delete, move, generation end and focus return (`refetchOnWindowFocus: "always"`) all advance it or trigger this. Selecting a swipe whose body is already local still re-reads N × ~500 KB.

- Superseded: patching from command responses doesn't work, because `touchedVariantIds` misses deselected siblings and Moves. See the content-ETag and change-feed stages in [client-request-shaping-collapse.md](client-request-shaping-collapse.md).
- S, standalone: send `If-None-Match: <revision>` on the focus refetch of the summary and return 304 server-side. Today a focus return rebuilds the snapshot's cast prompts, openings and removal-eligibility queries (`src/server/conversation/snapshot.ts:98,191,297`) for nothing.

### 4. History ships every swipe's body and reasoning (high bytes, S→M)

`src/server/conversation/history.ts:124,153`. Cheapest first:

- S: omit `reasoning` from the page (36% of it) and fetch it when the collapsible opens.
- M: send only the selected variant's content, plus ids/positions for the rest. Fetch a variant when browsing starts and prefetch its neighbours (`useSwipeBrowsing`). On this chat, page 1 drops from 506 KB to ~80 KB.

### 5. Collapse the boot waterfall (high feel, S)

- S: start `/api/workspace` in parallel with `loadBoxClients()` (`src/client/main.tsx:27`, `App.tsx:47`) and pass the promise into the first render. A stalled Box module currently holds the app blank for up to the 10 s deadline (`registry.ts:124`).
- S, near one-liner: `serveIndex` (`src/server/app.ts:35`) is already a function. Have it inject `<link rel="preload" as="fetch" crossorigin href="/api/boxes">` and `/api/workspace`, plus `/api/conversations/<activeChatId>` and `…/history?page=1` (it can read `activeChatId` from SQLite). The browser starts all four while the 1.4 MB of JS downloads and parses, and Eden's `fetch` picks up the preloaded responses, so the waterfall becomes one level. Check that the request headers match (Eden adds none to a plain GET), or the preload is wasted.
- M, the full version: inline those payloads as `<script type="application/json" id="boot">` and seed the QueryClient. That removes all four round trips, but adds a serialisation/escaping obligation.

### 6. Cacheable Box and host modules (medium, S)

Box `client.js`/`client.css` are served `no-cache` with no ETag (`src/server/contract/boxes.ts:15`): 205 KB re-transferred on every load, on the critical path. The 8 `/host/*` chunks revalidate one by one, 8 round trips through Access on every load.

- S: have `/api/boxes` return a content hash per Box. The client imports `/boxes/<id>/client.js?v=<hash>`, and the server sends `immutable` for versioned URLs. That means zero requests on reload and still no stale modules. Do the same for `/host` with a build-time hash in the import map (`scripts/host-modules.ts`). The stability the comment wants comes from the import map, not the URL.
- Also load each Box's CSS in parallel with its JS, not after the module executes (`scripts/build-box-client.ts:10`).

### 7. Compression (medium, S, smaller than it looks)

Nothing is compressed at the origin. Both hosted instances sit behind Cloudflare, which compresses at the edge, so remote users mostly don't pay for this. Docker self-hosters without a proxy pay the full 2.9 MB / 506 KB / 1.48 MB.

- S: precompress `dist/**/*.{js,css,html}` to `.br`/`.gz` at build and serve by `Accept-Encoding`, at zero CPU per request.
- S: compress JSON responses over ~1 KB with Bun's `zstdCompressSync`/`brotliCompressSync` in an `onAfterHandle`, excluding `text/event-stream`. Items 1 and 4 remove most of the bytes; this is the catch-all.

### 8. Library and settings caches (medium feel, S each)

- Characters list fetched independently by `CharactersPanel.tsx:48` and `NewChatPanel.tsx:183`, Lorebooks by `LorebookPanel.tsx:25` and `LoreAttachmentEditor.tsx:28`, conversation preset under three keys (`useLorebookAttachments.ts:10`, `BoxBlockNotice.tsx:40`, `usePromptPresetEditorRuntime.ts:54`). Share query options per resource, one key, `staleTime: Infinity`, invalidated by mutations.
- `ChatsPanel.tsx:30` refetches the full `/api/workspace` on every open, and `chat-summaries.ts:11` loads each chat's full latest message to cut a 160-char excerpt. Use a shared workspace query and `substr()` in SQL.
- Lorebook edits invalidate the whole list and recount every book (`useLorebookEditor.ts:36`, `library.ts:135`). Patch the one row from the returned book.
- `getWorkspace` builds full character summaries to keep `{id, name}` (`src/server/database/workspace.ts:5`). Select the two columns.
- Rename does GET-then-POST (`src/client/workspace.ts:63`). Put `revision` in the chat-list row.

### 9. Images (medium for image-heavy chats, L)

Portraits, editor chips and story images all load the original, up to 20 MB (`ingest.ts:67`, `Portrait.tsx:10`, `prose.tsx:89`). Generate a ~256 px WebP at ingest, keyed by the same content hash, and use it everywhere except the dialog. Uploads go as base64 JSON (`src/client/lib/image.ts:4`), +33% bytes and an extra copy in memory. POST the `File` directly.

### 10. Smaller items

- `index.html` has no `Cache-Control` and no validator, and the SPA fallback serves it for missing `/assets/*` (`app.ts:46`). Send `no-cache` + ETag, and 404 non-navigation misses. That also turns "rebuilt under a live server" into a clean 404 instead of HTML parsed as JS.
- Settings panel fans out one decision-settings GET per decision Box on every mount (`DecisionSettingsEditor.tsx:38`). Cache per Box.
- Preload hints worth adding once 5 lands: the Alegreya 400 italic face, which arrived late in the capture, and hover-prefetch of a chat row's summary + page 1 in `ChatsPanel`.

## The structural move

Items 1, 3 and the focus refetch are one problem: the client has no cheap way to ask "what changed since revision N". Each caller answers it by refetching everything. One per-conversation SSE channel would answer it for all three: it emits `{revision, changedMessageIds, digest: {box, progress}}` and stays open while a chat is open. Digest polling, refetch-after-mutate and focus refetch all become "patch on event", and the server folds only on change. Cloudflare serves HTTP/2 to browsers, so the extra stream costs no connection slot remotely. It replaces three polling/invalidation paths rather than adding a layer next to them, which is the test for whether it earns its place. Build it after the S items above if they leave the numbers unsatisfying; on their own they take most of the waste out.

## Checked and fine

- Generation SSE sends incremental deltas, has a bounded 256-event replay, and no heartbeat (`generation-runtime.ts:122`, `generation-sse.ts:52`).
- Prompt plans and provenance stay out of history and are fetched on inspection.
- Model pickers read the persisted catalog; provider discovery runs only on explicit refresh.
- Images are content-addressed with one-year immutable caching.
- Hashed assets get `max-age=86400` + ETag. 89 font files ship, but the browser picks only the subsets it needs (4 faces loaded in the capture).
- Server latency is not the bottleneck: warm reads are 1–40 ms. The costs are bytes, parse time and serial round trips.
