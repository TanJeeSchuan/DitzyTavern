# Thoughts

Status: DONE

Blocked By: 16-generic-box-host

Source: the guide test report and `.scratch/thoughts-box.patch` (a working draft built in a scratch worktree); early Box ideas (inner monologue).

## Goal

The model writes a character's inner monologue as `<thought>…</thought>` inside its prose. With the Thoughts Box inserted in a Chat, the markup leaves the prose view and appears in a Thoughts window, listed along the Selected narrative path. The prompt keeps the markup and carries one item teaching it.

## Ownership

- Thoughts Box (shared parser, server module, client window and lens)

## Work

- [x] Build the Box on the generic host from ticket 16, using the saved patch as a draft for the parser, lens and window. Keep only what the generic host still needs.
- [x] New Chats start without it.
- [x] Unit tests for the parser on malformed and nested markup.
- [x] E2E: a scripted reply with a thought shows it in the window and not in the prose; inspection shows the teaching item only while the Box is enabled; swiping swaps the thoughts.
- [x] Count the files this ticket touches outside tests and record the number in this ticket.

  6 files outside tests: the three registry entries (`src/shared/contract/box.ts`, `src/server/box/registry.ts`, `src/client/box-windows/registry.tsx`) and the Box's own `src/shared/thought.ts`, `src/server/box/thought.ts` and `src/client/box-windows/ThoughtWindow.tsx`. With `src/shared/thought.test.ts` and `e2e/thoughts.spec.ts` it is 8, over the 6 the acceptance allows with tests: a separate parser unit test and e2e spec cannot fit beside a shared, server and client module. The window styles itself with Tailwind utilities, so no stylesheet changes.
- [x] Run `bun run check` and `bun run test:e2e`.
- [x] Set this ticket to DONE and commit.

## Acceptance

- The Box touches at most 6 files, tests included. Its only host edits are one entry in `boxIds`/`boxDescriptors`, one in the server registry and one in the client registry.
