# Issue tracker: Collattice

Issues, specs, and tickets live on the `DitzyTavern` board in [Collattice](https://collattice.tanjs.dev), slug `ditzytavern`. Use the `collattice` MCP server with board ID `b20b1b98-aab3-4018-9451-2fe02aa18daa` for board-level reads. Every call requires the locally configured `authKey`; never put that key in card content, commits, docs, or logs.

## Board

The board is flat. Lanes are workflow state, not hierarchy:

- `Heads`: umbrella cards holding feature specs and maps.
- `Blocked`: specified tickets with open blockers.
- `Ready`: unblocked tickets available to an AFK agent.
- `In Progress`: claimed tickets.
- `Done`: completed tickets and deliberate `wontfix` work.

The `HEAD` label marks umbrella cards. The `ready-for-agent` label appears only on cards in `Ready`. Apply the labels in [triage-labels.md](triage-labels.md) where they fit.

## Card links

Collattice has no native parent or blocking relation. Encode links in the card description:

- Every child ticket has `Head: #N`, where `#N` is its umbrella card.
- Every ticket has `Blocked by: #N, #N` or `Blocked by: None`.
- A blocker is open until its card reaches `Done`.
- Card numbers are board-scoped. Use exact `#N` references; this convention assumes one project board.

Child `Head:` lines are the authoritative membership record. A head card may also carry a human-readable `## Children` list, but agents derive membership from the children when they need certainty.

## Conventions

- Create or update the head card first, with the spec in its description. Give it the `HEAD` label, place it in `Heads`, and leave off `ready-for-agent`.
- Create child tickets in dependency order. Put each in `Blocked` or `Ready`, add `Head:` and `Blocked by:`, and apply `ready-for-agent` only when the card belongs in `Ready`.
- Update checklists in the description as work proceeds. Add conversation history as comments.
- Move a blocked ticket to `Ready` only after every referenced blocker is in `Done`, then add `ready-for-agent`.
- Move a head card to `Done` after every child with its `Head: #N` reference is in `Done`. Recurse when a head has its own `Head:` reference.

## When a skill says "publish to the issue tracker"

Use the `collattice` MCP card tools. Create the head card first, then the child tickets in dependency order so each blocker already has a card number. Return every created card number and title.

## When a skill says "fetch the relevant ticket"

Use `get_card` with the board ID and card number, always passing `commentsLimit`. Read the description, lane, labels, comments, `Head:` reference, and `Blocked by:` references before working.

## Wayfinding operations

Used by `/wayfinder`. The map is a head card with one child ticket per question.

- **Map**: keep Notes, Decisions-so-far, and Fog in the head card description. Keep its `## Children` list current for readability.
- **Child ticket**: add `Head: #N`, put the question in the description, and retain a `Type:` line (`research`/`prototype`/`grilling`/`task`).
- **Blocking**: resolve `Blocked by:` from card text. Native relations are unavailable.
- **Frontier**: select the unblocked `ready-for-agent` cards in `Ready`. Lowest card number wins.
- **Claim**: remove `ready-for-agent` and move the ticket to `In Progress` before any work.
- **Resolve**: append the answer under an Answer heading, move the ticket to `Done`, and leave the `ready-for-agent` label off. Append a context pointer to the map's Decisions-so-far. Move the head to `Done` when all its children are complete.
