# World Clock in the prompt

Status: TODO

Blocked By: 02-memory-recall-through-the-box-seam

Source: `docs/box-system/spec.md`, User Stories 17–20, 22; Implementation Decisions "Storage scopes", "History semantics", "Generation lifecycle" step 5, "World Clock Box"; ADR-0038, ADR-0047, ADR-0050.

## Goal

With a World Clock Decision Model selected, each selected passage is digested in the background. The next Generation's Prompt Plan contains a line like `8:41 AM | 🗓️ Saturday, December 20, 2025 AD | ☀️ Clear, 3°C` that follows the Selected narrative path.

## Ownership

- `library_data`
- Variant seeds and Box record slots
- Host digest queue
- World Clock Box

## Work

- [ ] Add `library_data (namespace, key, value)`.
- [ ] Store one Generation seed per Variant. Imported or seedless Variants use a hash of their id. Boxes derive their own stream from the seed and their id.
- [ ] Add `records` (`initial`, `fold`, `digest`) to the contract. Store the `{ automatic?, writer? }` slot per Box in Variant data. State is the fold over effective records of selected Variants in Message order.
- [ ] Build the host digest queue. It queues digests when a selected Variant resolves, becomes selected without a record, or has its text edited. It runs at most two workers, puts live jobs before catch-up runs, and cancels superseded work by epoch. Generations never wait for it.
- [ ] Add a global World Clock Decision Model selection (profile, model, state token limit) in `library_data`, edited in settings next to the other Decision Model selections. Without a selection, no digest runs.
- [ ] Add World Clock setup in `conversation_data`: start date and time, era suffix (default `AD`), climate preset, hemisphere, unit (default °C). Edit it through a minimal settings form until ticket 04 adds the window.
- [ ] The digest sends one System One request with the passage and one preceding Message. It asks two `choice` questions: elapsed-time bin and weather established. Exact minutes are drawn within the bin from the Variant's seed.
- [ ] Fold: time advances by each passage's duration. Weather becomes unknown 24 in-world hours after its last mention. Temperature is derived from climate, hemisphere, season, hour and weather. The calendar is Gregorian.
- [ ] `advance` contributes the clock line, and leaves weather out when it is unknown.
- [ ] Unit tests: weekday and calendar rollover, weather fade, the temperature function, minutes staying inside their bin.
- [ ] E2E: scripted `/systemone` digests across two passages, the clock line in inspection, and a selection change that switches the clock to the other Variant's record.
- [ ] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- A swipe digests the new Variant, and selecting a Variant switches the clock to that Variant's records.
- A digest that is still pending never delays a Generation. The clock may lag by one passage.
- Without a selection, the clock line shows the start time, or the last known time, unchanged.
