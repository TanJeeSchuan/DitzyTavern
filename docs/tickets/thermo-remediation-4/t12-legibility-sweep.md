# T12 — Legibility closing sweep

Status: TODO

Blocked By: T1, T2, T3, T4, T5, T6, T7, T8, T9a, T9b, T9c, T10, T11

Source: issue #52, **§7 Legibility**. Many items may already be gone after earlier tickets; re-measure before editing.

## Mechanics

1. Clear every `bun run lint` warning (the issue listed: overlong lines in `connection-settings/presets.ts`, `lorebook/semantic.ts`,
   `generation-plan/compiler.ts`; unapproved comments in `connection-settings/index.ts`, `test-fixtures/conversation.ts`,
   `application/process-state.ts`). Re-run lint for the current list.
2. jscpd clones (`bunx jscpd src --min-tokens 50 --ignore "**/*.test.ts,**/contract/**,**/schema.ts,**/test-fixtures/**"`):
   - `conversation/internal.ts` ↔ `conversation/snapshot.ts` variant row projection: fold into one projector.
   - `shared/prompt-macro-syntax.ts` self-clone (~:230 ↔ ~:362).
   - `styles/theme.css` light/dark token blocks: derive one from a single map if CSS allows it cleanly; otherwise record why not.
3. `server/conversation/commands/accept-generation.ts` (~:492) one-liner `authorRoleOf({ author: toAuthorStamp(…), historicalContext: … }, { … })`:
   name the intermediate values.
4. Comment ratio: `client/import-chat.ts` (41%), `server/sillytavern/import-projection.ts` (31%), and `client/conversation-command-runner.ts`
   if it survived T7. Delete `@approved` justifications for shapes that no longer need defending. Keep comments that state a non-obvious constraint.

- **Behavior changed:** none.

## Files owned

Whatever the measurements above point at. No other ticket is running at the same time.

## TODO

- [ ] 1. lint warnings: 0
- [ ] 2. jscpd clones on non-test code: 0 (or justified)
- [ ] 3. accept-generation line
- [ ] 4. comment trim
- [ ] typecheck, lint, check:contracts, `bun run test`
- [ ] Commit

## Outcome
