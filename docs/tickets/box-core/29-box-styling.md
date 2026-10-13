# How a Box styles its UI

Status: NEEDS DESIGN

Blocked By: none

Source: GitHub #72. Found by the PR B reviews (ticket 28's Notes record the reverted prototype). The user deferred the decision to a separate discussion.

## Problem

`docs/box-system/README.md` tells Box authors to style Panels with Tailwind utilities. Built-ins get them only because their sources sit under `src/` when the host stylesheet is built: Tailwind scans them. A plugin installed into `data/boxes/` is built after the host, by `box:build`, which runs no Tailwind. Any utility the host stylesheet doesn't already contain renders unstyled.

## Rejected so far

- **Scoped Tailwind in the Box build, unprefixed.** `@reference` the host stylesheet and emit only `@tailwind utilities` from the Box's folder, in the host's `utilities` layer. No theme duplication and no preflight. Rejected because a Box sheet re-emits utilities the host already has, after the host sheet in the same layer, so they override host breakpoint variants on every element of the page. Tailwind treats any word as a class: Memory, Author Note and Race would each emit `.hidden`, and the Lorebook editor's `hidden … sm:block` divider (`src/client/workspace/LorebookEditorDialog.tsx`) disappears on desktop.
- **Emit only the utilities the host lacks.** Needs a custom `@tailwindcss/node` scanner pass instead of `@tailwindcss/vite`, and the host must stop scanning `e2e/`. Still misorders a Box's arbitrary base class against a host breakpoint class on the same property.
- **Scope the Box's utilities with `@scope ([data-box="<id>"])`.** Host elements outside the Box are safe, but host SDK components render inside the Box: a scoped Box base rule (`flex-col-reverse`) beats the host's unscoped breakpoint rule (`DialogFooter`'s `sm:flex-row`) through scoping proximity. Radix portals also need the marker propagated.

## Options on the table

- **Per-Box Tailwind prefix** (orchestrator's pick). The Box build runs Tailwind v4 on the Box folder with `prefix(<id without hyphens>)` against the host theme: `worldclock:flex worldclock:gap-2`.
  - Removed: reliance on the host scan.
  - Introduced: one Tailwind pass in the shared Box build.
  - Behavior: prefixed classes can't match host or other Boxes' classes, work through portals and inside SDK components. A prefixed class on an SDK component's `className` overrides its host classes, which is what an override means. Built-ins migrate their class strings: mechanical, more verbose.
  - To check: Tailwind v4's allowed prefix characters, and id collisions after stripping hyphens.
- **CSS Modules** (Astra's pick in the core review). Boxes style with `.module.css` and the host's theme variables; Vite hashes class names per Box.
  - Removed: utility authoring for Boxes.
  - Introduced: nothing new in the build; the supported theme variables get documented.
  - Behavior: no collisions at all. Authors write CSS declarations, and every built-in rewrites its markup styling.
- **Built-ins keep Tailwind, plugins ship plain CSS.** Smallest change. Built-ins and plugins stop styling the same way, against the one-loader decision.

## Work

- [ ] Decide the approach with the user.
- [ ] Implement it in `scripts/build-box-client.ts`, migrate the built-in Boxes and the fixture plugin, and make the fixture use a style the host doesn't contain so `e2e/box-plugin.spec.ts` covers it.
- [ ] Rewrite the styling paragraph of `docs/box-system/README.md` (Windows and dock).
- [ ] Run `bun run check`, `bun run build` and the full `bun run test:e2e`.
- [ ] Set this ticket to DONE and commit.
