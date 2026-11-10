# Box versions

Status: TODO

Blocked By: 03 (Creator Mode), 03b's saved sessions (PR #204)

Source: the Creator Mode scope discussion of 2026-11-05, and two Astra reviews: one of a global hot-swap revise plan, which found it needed a read-only twin of the startup schema check, a hold and drain of Generations and digests, and a remount of every open frame; and one of this ticket's first draft (findings folded in below).

## Goal

A sandboxed plugin Box can be revised after it's installed. Each install is an immutable version named by its content hash. Each Chat pins one version of each Box it has held, and moves to a newer one only by an explicit upgrade that first checks the Chat's stored data against the new version without writing anything.

Pinning turns the global-swap problems into equality checks: work captured under one version lands only if the Chat still pins it; a UI file named by its hash can be cached forever; a frame keyed by version remounts when the pin changes; rolling back is moving the pin back, through the same check.

This replaces 03b's "Revising an installed Box" item. 03b's live candidate preview stays deferred.

## Ownership

- `src/server/box` (versioned folders, the registry, the loader, the upgrade check)
- `src/server/authoring` (Install creates a version and moves `latest`; checks cached by version)
- `src/server/conversation` (the pin, the upgrade command, Fork, window commits, pending records)
- `src/client/box-windows` (registry, frame and UI source keyed by version; Box manager **Update**)

## Design decisions already made

- **Only sandboxed plugin Boxes are versioned.** Trusted Boxes (built-in, or a plugin with `server.ts`, `src/server/box/registry.ts:166`) and built-in sandboxed Boxes (Race, Mood) keep today's model: one version, replaced on restart, values checked at startup by `schema-check.ts`.
- **Layout.**

  ```text
  data/boxes/<id>/
  ├── versions/<hash>/   descriptor.json, logic.js, ui.js, ui.css, deps.lock.json, deps/, bundles
  ├── latest             the hash new Chats pin
  └── checks/            <version>-<scenario>.json, cached run_scenario results
  ```

  `<hash>` is the sha256 of the version's source files and `deps.lock.json`, sorted by path. Bundles and `deps/` are built once, in a staging folder renamed to `versions/<hash>/`. A version folder that already exists holds the same sources, so creating it again is a no-op. Nothing writes into a version folder afterwards.
- **Two kinds of lookup.** About 50 calls in 33 production files look a Box up by id (`serverBox`, `serverBoxes`, `boxDescriptor(s)`, `boxMetadata`). Each becomes one of:
  - **Catalog:** label, summary, icon, `startsEnabled`, and the instructions and role a new preset block starts with (`src/server/prompt-preset/blocks.ts:118`). These come from `latest`. The shared registry (`src/shared/contract/box.ts:43`), which overwrites entries by id, holds `latest` only.
  - **Chat-resolved:** hooks, schemas, Moves, records, read, digest, window. These resolve the Chat's pin first.

  The PR lists every call site and which kind it is. Existing preset block text is authored and shared, and never changes with a version.
- **The pin outlives presence.** Removing a Box clears its lifecycle and keeps its Moves and records ([Lifecycle per Chat](../../box-system/README.md#lifecycle-per-chat), [Storage](../../box-system/README.md#storage)). The pin is stored outside the Box's lifecycle namespace, so it survives removal: it says which version interprets the Chat's history. Inserting the Box again uses the pinned version, or goes through the upgrade check to reach `latest`. Fork copies the pin.
- **The insertion instance is kept on upgrade.** Only the current instance's records fold ([Storage](../../box-system/README.md#storage)), so a new instance would hide the whole history. Instead, frame tokens bind to the version as well as the instance, which is what remounts an open window.
- **Upgrade is per Chat, explicit, atomic, and read-only until it passes.**

  ```text
  upgrade(chat, box, to)                       // one transaction
    every record slot of the Box in the Chat, automatic and writer, on every Variant → passes to.record
    every Move list on a Human Message → passes to.moves.schema and to.moves.max
    the Chat has records or Moves but to declares no record or moves → refused
    setup → passes to.setup.schema and to.setupError
    chat and participant values → pass to.values
    every place Fork remaps an id is identical, by path, in to's schemas:              // row-references.ts:38-46
      each rowReference annotation, and each Record keyed by ParticipantKey (no annotation)
    any failure → refused, listing each failing place; nothing written
    pass → write the pin, advance the Chat's revision
  ```

  This checks each stored item, not every combination: it does not prove a fold over a swipe the writer selects later succeeds, only that each record it would fold is valid. A failed upgrade changes nothing. Clearing failing data to force one is a separate writer action, outside this ticket. Moving the pin back runs the same check.
- **Shared values are not checked.** Library and Character values have no schema in the contract (`values` declares `chat` and `participant` only, `src/shared/contract/box-descriptor.ts:45`), and shared writes are stored as strings unchecked (`commit-box.ts:50`). A Box already has to parse them defensively, since any write may come from another Chat at any time; versions add writers, not a new kind of failure. `contract.md` says so: a version must read values an older or newer version wrote.
- **Stale work is dropped by equality.** A Generation's pending record envelope, stored durably today as `{ instance, record }` (`src/shared/contract/box-generation.ts:8`) and copied on completion (`active-generation.ts:271`), gains the version it ran under; completion writes the record only if the Chat still pins that version. A digest job carries its version and its result lands only if the pin matches. The preview fingerprint includes the version. Completed records carry no version.
- **Window operations carry their version.** A window commit, stage or upload sends the version its frame runs. The server refuses one whose version isn't the Chat's pin, on top of the existing revision check, so a second tab's old window can't write after an upgrade (`BoxFrame.tsx:165`, `commit-box.ts:31`).
- **The client keys everything by version.** The client registry key is `<id>@<hash>`, the UI source is served at an immutable URL per version and cached forever, and the frame key includes the version. An upgrade that would discard a window's unsaved draft asks first, through the window's existing save guard.
- **Install is "create a version, then move `latest`".** It no longer copies into staging and claims the target. An id folder without `versions/` (a trusted plugin, or a sandboxed folder made by hand) refuses Install. Moving `latest` changes only the catalog and what new insertions pin; existing Chats show "Update available".
- **Install is gated on the server** by a passing `run_scenario` result cached for that exact version. The panel's gate stays as a hint.
- **Loading.** A version loads the first time anything needs it (a Chat opens or generates, a digest runs, an upgrade checks it) and stays loaded until restart. No eviction, and no garbage collection of version folders in this ticket: queued digests resolve their runtime late (`digest.ts:115`), and history needs its pinned version even after the Box is removed.

## Work

- [ ] Version folders: create from a candidate (hash, staging build, rename), read, list. Tests: identical sources give the same hash and a second create is a no-op; a changed `deps.lock.json` gives a new hash.
- [ ] Registry: catalog entries from `latest`; Chat-resolved lookups through the pin. The PR lists every call site with its kind.
- [ ] The pin: written on first insertion, kept on removal, used on reinsertion, copied by Fork.
- [ ] The upgrade check and command. Tests, one per rule: a writer record on an unselected Variant that the new record schema refuses; a Move list over the new `max`; a version that drops `record` while records exist; a `setupError` that refuses the stored setup; a changed `rowReference`; a `ParticipantKey` Record turned into a string-keyed one, which accepts the same values but would stop Fork remapping its keys. Each is refused and leaves every row unchanged. A passing upgrade writes only the pin and advances the revision.
- [ ] Version in the pending record envelope and in digest jobs; completion compares. Tests: a digest started under v1 that ends after the Chat moved to v2 writes nothing; a Generation that captured v1 completes its prose but not its v1 record once the Chat is on v2; a preview made under v1 is stale under v2.
- [ ] Window commits, stages and uploads carry the version and are refused on a mismatch. Test: an old window's commit after an upgrade is refused even at the current revision.
- [ ] Install creates a version and moves `latest`, gated on a cached passing check; remove the staging copy and target-claim code it replaces from `install.ts`.
- [ ] Startup: load `latest` and the versions Chats pin on demand; skip `schema-check.ts` for versioned Boxes.
- [ ] Client: registry, UI URL and frame keyed by version; "Update available" and **Update** in the Box manager, with refusals listing their places.
- [ ] `contract.md`: versions must read shared values another version wrote, and must keep every row reference: `rowReference` annotations and `ParticipantKey` Records.
- [ ] e2e: install v1, add it to a Chat, revise and install v2 from the same Creator Mode session. The Chat stays on v1 with v1's window; a new Chat starts on v2; **Update** moves the first Chat to v2, its window remounts, its v1 records still fold, and the next Generation's Prompt Plan has v2's prompt items.
- [ ] Update `docs/box-system/README.md` (loading, Creator Mode) and ticket 03's "never side by side" line.
- [ ] Run focused tests and lint on changed files; push and let CI run the full suite and e2e.

## Acceptance

- Revising an installed Box never changes a Chat that didn't choose to upgrade.
- An upgrade that fails any check is refused and writes nothing; one that passes keeps the Chat's records folding.
- No work captured under one version writes into a Chat pinned to another, from a Generation, a digest or a window.
- An open window always runs the version its Chat pins.

## Not in this ticket

- `box:scenario`, a check-only CLI for external coding agents. It doesn't depend on versions and can ship first.
- Saving each full `run_scenario` input in the session log (today's log holds inputs cut at 64 KiB), which export to an external agent needs.
- Submitting an externally edited folder as a version. Once this lands it is "create a version from a folder", behind the same writer-approved Install.
- Clearing a Chat's failing data to force an upgrade.
- Checking a candidate against the previous version before Install, and **Install as a new Box** ([04b](04b-cross-version-checks.md)).
- Garbage collection of versions, and unloading them.
- A live preview of an uninstalled candidate's UI (03b).

## Open risks

- **Memory.** Every version anything has needed since startup stays loaded, each with its own QuickJS context of up to 64 MiB. Fine for a handful of versions; eviction needs job ownership, not open-Chat counting.
- **Disk.** Without garbage collection, every installed version stays on disk.
- **Call sites.** A lookup left resolving by id alone silently uses `latest`. The PR's call-site list is the review surface.
- **Swipe combinations.** The upgrade check validates each record, not every fold a later selection could produce. A fold that throws on a valid but unusual combination still fails at that point, as it can today.
