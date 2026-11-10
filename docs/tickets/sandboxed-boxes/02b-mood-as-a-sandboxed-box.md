# Mood as a sandboxed Box

Status: DONE

Blocked By: 02

Source: `docs/research/sandbox-box-landmark-fit.md` (Decision rows of the Memory inventory; cancellation), `docs/research/sandboxed-box-spike.md` (Promise bridge and cancellation), `src/boxes/mood`.

## Goal

Sandboxed Boxes can digest settled prose and ask their Decision Model questions through `decide`. Mood, rewritten as a sandboxed Box, passes `src/boxes/mood/mood.spec.ts` with unchanged story assertions. The trusted Mood is removed.

This is what lets Creator Mode build Boxes that track prose (mood, relationships, time passing in the story), not only ones driven by writer Moves.

## Ownership

- `src/server/box` (the adapter's digest path and the `decide` bridge)
- `src/boxes/mood`
- `docs/box-system/sandboxed.md`

## Design decisions already made

- Only `decide`, and only inside `digest`. The host injects it into the digest call and nowhere else. `complete` and `embed` stay deferred to the Memory capability work in #69, because they take arbitrary prompts and outputs and need grants and budgets.
- The descriptor's `decision` block keeps the host in charge of choosing the Decision Model. The guest never sees a profile id.
- One `decide` call per digest invocation; a second call is refused. One call already takes several questions, so Mood needs only one. The digest queue may retry a job, but each invocation still makes at most one request, so no general spending budget is needed.
- Each digest invocation runs in its own QuickJS context, created for it with `decide` injected and disposed when it settles or is cancelled (ticket 01's rule for hooks that receive a capability). `advance`, other digests and later calls run in other contexts, so there is nothing to stash `decide` into. Two digest workers can run at once; each still has its own context.
- `decide` resolves to answer entries (`[key, DecisionAnswer][]`), not a `Map`.
- Mood's window is the host's `digestWindow`, declared in `descriptor.json`. It needs no frame.

## Work

- [x] Adapter: `records.digest` with `window` and an async `run` through the Promise bridge. The host supplies the passage, preceding passages and the other digest inputs it supplies today.
- [x] `decide(state, questions)`: uses the Box's resolved Decision selection, request packing and token limits exactly as the trusted path does.
- [x] Cancellation: when the digest queue supersedes or drops a job (a newer passage, a Swipe, the Box disabled or removed), outstanding `decide` promises reject in the guest, the host aborts the request, and late answers are dropped. A cancelled job writes nothing.
- [x] Errors: a guest throw or a refused answer lands as a digest error, as it does for trusted Boxes.
- [x] `descriptor.json`: the `decision` block, a digest window (`{ kind: "digest", icon, size }`, with `icon` from a fixed list of icon names), and a sync `status` hook in `logic.js`. The client registration from ticket 01 builds the digest window with `digestWindow` (`src/client/box-windows/PassageTimeline.tsx:82`) instead of a frame.
- [x] Build: Mood follows Race's path from ticket 02 (`logic.ts` bundled at server startup, no `client.tsx`).
- [x] Rewrite Mood as `descriptor.json` + `logic.js` and delete its trusted files. Stored Mood records stay valid; the record schema does not change.
- [x] `mood.spec.ts` passes with its story assertions unchanged.
- [x] Contract tests: a digest whose `decide` is pending when its job is superseded rejects in the guest and writes nothing; a second `decide` in one digest is refused; a digest that assigns `globalThis.saved = decide` and stays pending leaves `saved` undefined in a concurrent `advance` and in a concurrent second digest.
- [x] Document the sandboxed digest path in `docs/box-system/sandboxed.md`.
- [x] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.
- [x] Set this ticket to DONE and commit.

## Acceptance

- Mood behaves as before: digested passages, a Swipe, a Writer override, an unclear passage and an override racing a landing digest.
- A sandboxed Box can reach a model only through `decide`, inside `digest`, using the model the writer chose.

## Implementation notes

- **Runtime per digest.** `sandboxedBox` evaluates `logic.js` for each `records.digest.run` in a runtime of its own: a fresh instance of the compiled QuickJS module on its own 64 MiB `WebAssembly.Memory`. It hands the guest `{ decide }` as the second argument. The Box's long-lived runtime keeps the sync hooks and `read`. The pump awaits the one host request in flight between job pumps, so each pump still runs under its own 100 ms deadline. Review round 1: a fresh context in the shared runtime was not reclaimed after an interrupted promise chain, so six failed digests holding 8 MiB exhausted the heap. Disposing such a runtime fails QuickJS's `list_empty(&rt->gc_obj_list)` assertion, so a digest's runtime is dropped without `dispose`. RSS stayed flat at about 106 MiB over 300 such digests, so the garbage collector reclaims the instances.
- **`decide`.** The host function takes `[state, questions]` as one JSON string, held to the 4 MiB limit, and checks that each question names a `type`. It then calls the job's own `ctx.decide`, so the selection, packing and token limits are the trusted path's. A second call, or input over the limit, throws in the guest. A failed request rejects in the guest.
- **Cancellation.** `ctx.decide` takes an optional `signal`, as `embed` does. Each digest passes one that it aborts when it ends, so a guest that fires `void decide(...)` and returns cannot leave a request running past its digest and the worker limit. The job's `signal` both aborts the request (through `ctx.decide`) and rejects the guest's pending `decide` with `The <id> Box's digest was cancelled.`, without waiting for the request to settle. A late answer finds no pending promise and is dropped. A digest that returns after its signal aborted throws instead, so even a guest that swallows the rejection writes nothing. A Swipe keeps the old Variant, so the queue does not drop its job, and the digest of that Variant still lands.
- **Window.** `window.kind: "digest"` sits beside `icon` and `size`. The descriptor check requires it exactly when the Box declares a `decision`, because the passage timeline reads only a digesting Box, and a frame's read would get the timeline instead of `{ snapshot, status, view }`. A digest-window Box has no `ui.js`, and the frame route refuses to open a frame for it. `drama` joins the icon list for Mood.
- **Hook declaration.** The bridge walks the default export into dotted hook paths at any depth (stopping at `records.initial`), so `records.digest.window` and `records.digest.run` are declared like the other hooks. The digest `window` crosses in the declaration with `initial`.
- **SDK.** `@/box-sdk/shared` now exports the `DecisionAnswer` type, since a sandboxed `logic.ts` may import only that layer.

