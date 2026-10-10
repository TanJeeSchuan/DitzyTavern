# Box windows and dock, starting with the World Clock

Status: TODO

Blocked By: 03-world-clock-in-the-prompt

Source: `docs/box-system/spec.md`, User Stories 9–11; Implementation Decisions "Windows", "World Clock Box" (window, status); DESIGN.md.

## Goal

A writer opens the World Clock in a floating window, drags it aside, and minimizes it to a tab docked at the bottom right beside the composer showing `8:41 AM · ☀️ 3°C`. Reloading the Chat restores the layout.

## Ownership

- Box window and dock surfaces
- Client-side per-Chat window layout
- World Clock window

## Work

- [ ] Add `window` (`icon`, `size`, `Panel`) and `status` to the contract.
- [ ] Add a floating window surface: draggable, not resizable, several open at once, opened from a Box launcher. Use Radix/shadcn primitives and follow DESIGN.md.
- [ ] Add the dock at the bottom-right edge beside the composer. Minimized windows become tabs showing the icon and `status`, updated live.
- [ ] Keep open state, minimization and positions client-side per Chat. On narrow layouts a window becomes a full-screen layer.
- [ ] Add the World Clock window: setup form, plus a passage timeline listing elapsed time and weather per selected passage. Remove the interim form from ticket 03.
- [ ] Verify manually with playwright-cli on desktop and narrow widths. No UI tests.
- [ ] Run `bun run check` and `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- Opening, dragging or minimizing a window never reflows the Chat.
- The dock status updates when a digest lands, without reopening the window.
- The Author Note and Memory panels are unchanged.
