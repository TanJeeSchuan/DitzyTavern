# Digests read the Chat

Status: TODO

Blocked By: none

Source: GitHub #68 "Extraction → `digest`". Memory's extraction cannot run on today's digest: it calls an extraction model, cites message ids as evidence, and reads the Chat's Cast identities and Memory note. Ticket 22 ports it. This ticket grows the host first.

## Goal

A digest gets what an `advance` already gets: the services its Box injects, and the Chat it runs in. Failed digests are visible and are not retried forever. World Clock and Mood behave exactly as before.

## Decisions

- `DigestContext` carries the Box's declared `inject` services (`llm`, `decide`, `embed`) the way `advance` does in `src/server/box/registry.ts`, not `decide` alone. `decide` keeps the Box's own Decision selection.
- Each `DigestPassage` gains its `messageId`.
- The digest window gains the Chat's Cast and the Box's own `box:<id>` `conversation_data` values. Use the existing read helpers (`readConversationData`); do not add a Box-to-Box read.
- A Box that should not digest a passage (for example one by an excluded author) returns an empty record. The queue gets no eligibility hook.
- The record slot (`src/shared/contract/box-digest.ts`) gains `error?: { source, message }`. A failed digest writes it. The queue does not retry a slot whose `error.source` matches the current source hash. Catch-up retries it. A successful digest clears it.
- Catch-up progress reports `failed` next to `total` and `remaining`.

## Work

- [ ] Pass injected services, message ids, the Cast and the Box's conversation data to `digest.run`.
- [ ] Add `error` to the record slot, write it on failure, and skip and retry as above.
- [ ] Show a failed digest in the passage timeline (`PassageTimeline.tsx`) for World Clock and Mood, following DESIGN.MD.
- [ ] Update `docs/box-system/README.md` for the new digest inputs and the `error` slot field.
- [ ] Unit-test failure, skip and catch-up retry in `src/server/box/digest.test.ts`.
- [ ] Run `bun run check` and the World Clock and Mood e2e specs.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- World Clock and Mood e2e specs pass unchanged.
- A digest can call `llm`, cite message ids, and read its own per-Chat settings and the Cast with no Box-specific host code.
