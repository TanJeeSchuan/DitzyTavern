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

## Work

- [ ] Capabilities, each bound to the calling Box and its Chat:
  - `snapshot(query)`: a closed set of queries for the Box's own Participant values, its own Library values by key or prefix, and the source Character revisions it is allowed to read.
  - `commit({ snapshot, expected, writes, setup? })`: one atomic, revision-guarded batch of own Chat, Library, Participant and source Character values, optionally with setup. Conflicts return current values.
  - `uploadImage` and scoped image display for the frame.
  - Status as a string from `read`, rendered by the host.
  - `ui` events: dirty state with save/discard requests, close.
- [ ] Hooks: `setup` + `setupError` (sync, inside the command transaction), `dependencies` (seed, intent, withdrawn Cast), `read` with an expanded projection covering setup, seats, portraits and staged Moves. `spectatorOf` still strips intents and replay until the finish.
- [ ] Replace `node:util` `isDeepStrictEqual` with key-order-independent JSON equality.
- [ ] Rewrite the window (oval, replay, setup, stats, avatars) as `ui.html` using the token stylesheet. In-repo logic may be bundled from TypeScript with `bun build`; the loader only sees JS.
- [ ] Adapt the five Race specs: frame locators everywhere; `moves.spec.ts` read interception and `cast.spec.ts` direct reads move to the new transport. Prompt Plan, Stretch text, Swipe equality and model request assertions stay unchanged.
- [ ] Time a 200-Stretch race fold against the budget from ticket 00.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- The Race specs pass with unchanged story assertions.
- Hidden intents never reach the frame before the finish.
- No capability takes a Box id, namespace, SQL or profile id from the guest.

## Open risks

- Cumulative replay in each record makes fold payloads grow with Stretch count; ticket 00 measures it.
