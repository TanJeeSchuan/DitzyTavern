# Box windows and dock, starting with the World Clock

Status: DONE

Blocked By: 03-world-clock-in-the-prompt

Source: `docs/box-system/README.md` "Windows and dock", "Built-in Boxes" (World Clock); DESIGN.md.

## Goal

A writer opens the World Clock in a floating window, drags it aside, and minimizes it to a tab docked at the bottom right beside the composer showing `8:41 AM · ☀️ 3°C`. Reloading the Chat restores the layout.

## Ownership

- Box window and dock surfaces
- Client-side per-Chat window layout
- World Clock window

## Work

- [x] Add `window` (`icon`, `size`, `Panel`) and `status` to the contract.
- [x] Add a floating window surface: draggable, not resizable, several open at once, opened from a Box launcher. Use Radix/shadcn primitives and follow DESIGN.md.
- [x] Add the dock at the bottom-right edge beside the composer. Minimized windows become tabs showing the icon and `status`, updated live.
- [x] Keep open state, minimization and positions client-side per Chat. On narrow layouts a window becomes a full-screen layer.
- [x] Add the World Clock window: setup form, plus a passage timeline listing elapsed time and weather per selected passage. Remove the interim form from ticket 03.
- [x] Add a per-Chat World Clock toggle to its setup, off by default: off contributes nothing to the Prompt Plan and queues no digests; on sends the clock line and digests only with the global World Clock Decision Model selected.
- [x] Reject impossible calendar dates such as February 31 in the World Clock start, through the API and the setup form. Clean dev data instead of migrating stored setups.
- [x] Verify manually with playwright-cli on desktop and narrow widths. No UI tests.
- [x] Run `bun run check` and `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- Opening, dragging or minimizing a window never reflows the Chat.
- The dock status updates when a digest lands, without reopening the window.
- The Author Note and Memory panels are unchanged.
- With the World Clock off, its block is absent from the Prompt Plan and no digest runs; with it on and no global Decision Model selected, the clock line still shows the start or last known time.
- A start such as `2025-02-31T08:00` is refused rather than stored and rolled into March.

## Verification

- `bun run check`: passed, including 1,451 unit/contract tests.
- `bun run test:e2e`: 41/42 passed. `a stream that drops without finishing is recorded as a provider interruption` failed on the first full run and passed in isolation and on retry; it also fails on master.
- Manual playwright-cli at 1440x900 and 700x900: opening, dragging, reloading, minimizing and restoring the World Clock; the dock tab shows `8:00 AM` and no Chat reflow; narrow renders the full-screen layer with a working Tab/Shift+Tab trap, Escape close and focus restore; the off toggle and impossible-date validation behave.
- Sequential standards and spec reviews by `gpt-6.1-sol` at high reasoning. Fixed: Chat-scoped panel remount so one Chat's setup cannot leak into another (with a new e2e); a disabled clock is re-checked before a queued digest issues a provider request; validation shows only after the Start field blurs; icon-only window actions reveal immediate hover/focus labels; narrow full-screen layers trap Tab and move focus inside when the viewport shrinks. Declined: a strict throw for a corrupt stored window layout (matches `useThemePreference`'s validate-and-fall-back for client preference state) and replacing the non-modal window frame with Radix Dialog (Radix Dialog is modal; the spec requires several draggable windows open at once).
