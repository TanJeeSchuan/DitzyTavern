# Race as a sandboxed Box

Status: TODO

Blocked By: 01

Source: `docs/research/sandbox-box-landmark-fit.md` (Race dependency inventory, E2E impact, performance).

## Goal

Race runs as a sandboxed Box with the same simulation, hidden-state behavior and Prompt Plan as today. The trusted Race is removed. Every capability added is general, not Race-specific; needing a Race-specific host change means the capability set is wrong.

## Ownership

- `src/boxes/race`
- `src/server/box` capability bridge (the additions below)
- The frame bridge in `src/client/box-windows`
- `src/boxes/race/*.spec.ts`
- `vite.config.ts`, `scripts/build-box-client.ts` (built-in sandboxed Boxes)

## Work

- [x] Capabilities, each bound to the calling Box and its Chat:
  - `snapshot(query)`: a closed set of queries for the Box's own Participant values, its own Library values by key or prefix, and the source Character revisions it is allowed to read.
  - `commit({ snapshot, expected, writes, setup? })`: one atomic, revision-guarded batch of own Chat, Library, Participant and source Character values, optionally with setup. Conflicts return current values.
  - `uploadImage` and scoped image display for the frame.
  - Status as a string from `read`, rendered by the host.
  - `ui` events: dirty state with save/discard requests, close.
- [x] Hooks: `setup` + `setupError` (sync, inside the command transaction), `dependencies` (seed, intent, withdrawn Cast), `read` with an expanded projection covering setup, seats, portraits and staged Moves. `spectatorOf` still strips intents and replay until the finish.
- [x] Records stop copying the replay. Today each record is the full `RaceState`, so it repeats every earlier Stretch (`server-engine.ts:260`), and total record bytes grow with the square of the Stretch count (17.7 MB at 200 Stretches in ticket 00). Each record keeps standings and intents and adds zero or one new replay entry: a Stretch adds one, while a withdrawal during Hold, a walkover and the Results record add none (`server-engine.ts:119`, `:125`, `:143`). `fold` takes the snapshot fields from the last matching record, whether or not it adds an entry, and appends the entries, starting fresh when `raceId` changes. A writer override of an earlier record still leaves later standings unchanged. Existing stored Race records are cleared, not migrated.
- [x] Replace `node:util` `isDeepStrictEqual` with key-order-independent JSON equality.
- [x] Rewrite the window (oval, replay, setup, stats, avatars) as `ui.js` rendering markup with the token stylesheet; the oval as SVG markup. Avatars and Portraits need images, which ticket 01 blocks entirely (`img-src 'none'`). Open them here with Box-scoped authorization. Ownership is decided by the host, never by references the guest can write: an image is displayable if the host recorded an upload grant for it when this Box uploaded it through `uploadImage`, or if it is the Portrait of a Participant in this Chat's Cast. A Library value naming some other hash grants nothing. Each frame instance gets an image URL prefix bound on the server to its Box and Chat (not a shared prefix with a caller-chosen scope), the frame's `img-src` allows only that prefix, and the route serves the bytes directly. The existing image route stays out of `img-src`. The sanitizer and CSP must hold for every surface that loads an image (`img src` and `srcset`, CSS backgrounds, `poster`), and the isolation e2e covers each of them against an image the Box doesn't own, including one whose hash the Box wrote into its own Library values.
- [x] Build: Race's logic stays TypeScript in `src/boxes/race/logic.ts`. The registry bundles a built-in sandboxed Box's `logic.ts` and `ui.ts` with `Bun.build` at server startup, using the repository's normal resolution and packages (built-in source is ours, so it doesn't go through ticket 02c's confined build for guest Boxes), the same in development, production and Docker (which copies `src/boxes`), so there is no build artifact to go stale or missing. The guest only ever receives JS. The Vite build skips `buildBoxClient` for Boxes without `client.tsx` (`vite.config.ts:45`, `scripts/build-box-client.ts:57`). Check that the development server restarts when `logic.ts` changes; if `bun --watch` doesn't see it, the dev script watches `src/boxes`.
- [x] Adapt the five Race specs: frame locators everywhere; `moves.spec.ts` read interception and `cast.spec.ts` direct reads move to the new transport. Prompt Plan, Stretch text, Swipe equality and model request assertions stay unchanged.
- [x] With ticket 01's limits on, time a fold of the longest real race (3,200 m at 100 m per Stretch) and a 200-Stretch synthetic one with the compact records, and record whether they fit the 100 ms sync deadline. Change the limits in ticket 01's code if they don't.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- The Race specs pass with unchanged story assertions.
- Hidden intents never reach the frame before the finish.
- No capability takes a Box id, namespace, SQL or profile id from the guest.

## Implementation notes

- **Fold timing**, with ticket 01's limits, 18 Runners, through the sandboxed `foldAll`: the 3,200 m race at 100 m per Stretch is 33 records, 111 KB, median 6.7 ms; a 200-Stretch synthetic race is 683 KB of records, median 34.6 ms and at most 40.6 ms. Both fit the 100 ms deadline, so ticket 01's limits stay. A window `read`, which evaluates `logic.js` in a fresh context, takes about 10 ms. `logic-sandbox.test.ts` folds the 200 Stretches.
- **Capabilities.** `read(input, { snapshot })` is the one hook handed a capability, so it runs in a fresh context per call (ticket 01's rule). `commit` is the host command `commit-box`, which replaces `put-box-data`; `set-box-setup` lost `writes`, and the `boxData` Panel prop is gone. `expected` carries each Library or Character revision, and every Library or Character write needs one. A Character must be the source of someone in the Chat's Cast. A Participant value must fit its declared schema. Conflicts and refusals answer with the current read. Status is the read's `status`, which the host renders.
- **Images.** `POST /api/conversations/:id/boxes/:box/frame` mints a token bound in memory to the Box and Chat. The frame document, its images and its uploads all live under `/api/box-frame/<token>`. The frame's `img-src` is that image path, written with the request's host and no scheme. The sanitizer also drops `src`, `srcset` and `poster` outside it. Grants live in `box_image_grant`, which the orphan sweep skips. The seeded avatars get grants too, so `db:seed:race-avatars` must be run again on a database whose avatars predate grants.
- **Move labels.** A template's `{key}` now shows the literal's `title` when the Move schema gives one. Without it the Race's chip would read `overtake · …`. This is general: any enum field gets a display name the way the passage timeline already shows one.
- **Morphing renders.** Typing into a re-rendered input lost focus, so `render` now morphs with idiomorph instead of replacing the document. Focus, caret and typed value survive, and the oval's markers glide with a CSS transition, honouring reduced motion. The markers move in a straight line rather than along the track.
- **Read transport unchanged.** The window read stays at `/api/conversations/:id/boxes/race`, wrapped as `{ snapshot, status, view }`. So `moves.spec.ts` intercepts the same URL, and `cast.spec.ts` reads `view`.
- **Old records.** Migration `0038_clear_race_records` deletes every stored Race record slot, Writer overrides included, and pending Race records on Active Generations. The schema check alone deleted only automatic records and held old Writer overrides, which made every Race read throw.
- **Review round 1.**
  - Uploads: a frame runs one at a time and refuses the rest meanwhile. The server refuses past 200 granted Images or 100 MiB per Box.
  - Tokens: a token is bound to the Box's insertion instance, and the app closes it when the frame is torn down.
  - Images: image answers are `no-store`. A document already showing an image keeps it in its own list of available images, which no header reaches, so the e2e checks the frame's next document.
  - Drafts: the window's draft and stat sheet keep the revision, and the Character revision, they started from, until saved, discarded or refused as a conflict.
- **Deferred.** The `ui` close event has no consumer in the Race, so it is not built. Chat values in `commit` are not built either: Race writes none, and `snapshot`'s closed set has no Chat query to read them back.
- **Dev server.** `bun --watch` does not see files the registry only bundles, so `dev:server` runs `scripts/dev-server.ts`, which also restarts the server on any change under `src/boxes`.

## Open risks

- [Ticket 00 measured](../../research/sandboxed-box-spike.md) 17.7 MB of cumulative records at 200 Stretches. Batched fold took 562 ms versus 1,765 ms per-call; a transfer-only last-record probe took 552 ms. Batching is insufficient to establish an acceptable synchronous capture budget. Bound payloads and choose an explicit latency/heap budget before porting long histories.
