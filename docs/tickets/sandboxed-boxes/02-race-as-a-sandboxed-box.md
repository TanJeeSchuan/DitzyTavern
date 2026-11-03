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

- [ ] Capabilities, each bound to the calling Box and its Chat:
  - `snapshot(query)`: a closed set of queries for the Box's own Participant values, its own Library values by key or prefix, and the source Character revisions it is allowed to read.
  - `commit({ snapshot, expected, writes, setup? })`: one atomic, revision-guarded batch of own Chat, Library, Participant and source Character values, optionally with setup. Conflicts return current values.
  - `uploadImage` and scoped image display for the frame.
  - Status as a string from `read`, rendered by the host.
  - `ui` events: dirty state with save/discard requests, close.
- [ ] Hooks: `setup` + `setupError` (sync, inside the command transaction), `dependencies` (seed, intent, withdrawn Cast), `read` with an expanded projection covering setup, seats, portraits and staged Moves. `spectatorOf` still strips intents and replay until the finish.
- [ ] Records stop copying the replay. Today each record is the full `RaceState`, so it repeats every earlier Stretch (`server-engine.ts:260`), and total record bytes grow with the square of the Stretch count (17.7 MB at 200 Stretches in ticket 00). Each record keeps standings and intents and adds zero or one new replay entry: a Stretch adds one, while a withdrawal during Hold, a walkover and the Results record add none (`server-engine.ts:119`, `:125`, `:143`). `fold` takes the snapshot fields from the last matching record, whether or not it adds an entry, and appends the entries, starting fresh when `raceId` changes. A writer override of an earlier record still leaves later standings unchanged. Existing stored Race records are cleared, not migrated.
- [ ] Replace `node:util` `isDeepStrictEqual` with key-order-independent JSON equality.
- [ ] Rewrite the window (oval, replay, setup, stats, avatars) as `ui.html` using the token stylesheet.
- [ ] Build: Race's logic stays TypeScript in `src/boxes/race/`. `bun run build` bundles a built-in sandboxed Box's logic into `dist/boxes/<id>/logic.js`, which the Docker image already copies, and skips `buildBoxClient` for Boxes without `client.tsx` (`vite.config.ts:45`, `scripts/build-box-client.ts:57`). The loader reads a built-in's `logic.js` from `dist/boxes/<id>/` and a plugin's from its own folder; it only ever runs JS.
- [ ] Adapt the five Race specs: frame locators everywhere; `moves.spec.ts` read interception and `cast.spec.ts` direct reads move to the new transport. Prompt Plan, Stretch text, Swipe equality and model request assertions stay unchanged.
- [ ] With ticket 01's limits on, time a fold of the longest real race (3,200 m at 100 m per Stretch) and a 200-Stretch synthetic one with the compact records, and record whether they fit the 100 ms sync deadline. Change the limits in ticket 01's code if they don't.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- The Race specs pass with unchanged story assertions.
- Hidden intents never reach the frame before the finish.
- No capability takes a Box id, namespace, SQL or profile id from the guest.

## Open risks

- Cumulative replay in each record makes fold payloads grow with Stretch count; ticket 00 measures it.
