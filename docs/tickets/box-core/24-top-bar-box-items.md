# Top bar Box items

Status: DONE

Blocked By: none

Source: GitHub #77. The top bar's icon group (`src/client/story/StoryHeader.tsx`) is host-only. Boxes should be able to put an item there.

## Goal

A Box's client definition may declare a top bar item. The host shows the items of every Box enabled in the Chat in the top bar's icon group. The World Clock is the first consumer.

## Decisions

- The item is declared next to the Box's window in its client registration (`src/client/box-windows/registry.tsx`), as a component that receives the same Box state its window does. Clicking it opens the Box's window.
- The World Clock's item shows the current in-story time and opens its window.
- The host's Info, Variables and Memories icons stay host-owned. The Memories icon moves when the Memory UI moves into its Box (GitHub #24).
- Narrow-screen behavior follows DESIGN.MD. The icon group is hidden on narrow screens today (`src/styles/responsive.css`), so decide whether Box items need a narrow-screen home and record the decision in DESIGN.MD.
- Export what a Box needs to render an item from `src/box-sdk/client.ts`, and nothing host-internal.

## Work

- [x] Add the top bar item to the Box client definition and render enabled Boxes' items in `StoryHeader`.
- [x] Add the World Clock item.
- [x] Document the item in `docs/box-system/README.md`.
- [x] Add an e2e step in the World Clock spec: the item shows the in-story time and opens the window.
- [x] Run `bun run check` and the World Clock e2e spec.
- [x] Set this ticket to DONE and commit.

## Acceptance

- A new Box gets a top bar item by declaring one in its client registration, with no `StoryHeader` edit.
- A Box disabled in the Chat shows no item.
