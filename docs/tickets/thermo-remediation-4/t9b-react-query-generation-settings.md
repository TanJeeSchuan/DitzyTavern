# T9b — react-query for generation-settings draft; remove ref mirrors

Status: DONE

Blocked By: T9a

Source: issue #52, finding **F10**. Read the whole finding first.

## Problem (shared across T9a–T9c)

Client "latest-wins" concurrency is hand-rolled ~40 times with `useRef(0)` request/version counters, plus three
`stateRef.current = reduce(...)` mirrors. `@tanstack/react-query` is already a dependency and used at 8 sites
(`AuthorNotePanel`, lorebook, memories, generation settings); it gives abort-on-refetch and latest-wins for free.

## Mechanics (shared)

- **Remove:** the hand-rolled counters / ref mirrors in the files this ticket owns.
- **Introduce:** `useQuery` / `useMutation` with `signal` for reads and `mutationKey`-scoped mutations for writes, following the existing react-query sites.
- **Behavior changed:** stale-response suppression becomes react-query's; in-flight requests are aborted on key change instead of ignored on return. Intended.
- The generation SSE session keeps its runner: it is a stream, not a request.

## Rejected

- A shared `useLatest()` helper: standardises the hand-rolled model instead of removing it.

## Files owned

`src/client/workspace/useGenerationSettingsDraft.ts` (~10 counters), `src/client/workspace/prompt-preset/usePromptPresetEditorRuntime.ts` (~:68 mirror),
`src/client/workspace/useLorebookEditor.ts` (~:19 mirror), their tests and direct consumers.

## Behavior constraints (acceptance)

Each must hold after the migration; state in the Outcome how each is guaranteed (test name, or code reference if untestable):

- **Latest wins:** switching the key (Conversation, preset, position) while a read is in flight never applies the older response.
- **Abort:** the superseded request is aborted through `signal`, not just ignored.
- **No duplicate fetch:** mount, StrictMode double-invoke, and re-render with the same key issue one request, not two.
- **No resurrection:** a mutation that resolves after its owner unmounted or after the key changed does not write into the new state.
- **Optimistic revision:** writes still send the current `expectedRevision`; a 409 conflict still adopts the server's current state exactly as before.
- **Cache freshness:** pick `staleTime` / invalidation so a write in one panel is visible in every other reader of the same key without a manual reload; no stale cache served after a write.
- **Cost:** request count does not scale with list size or render count.

## TODO

- [x] Review fix round 1: pin and fix the seven reported races
- [x] Review fix round 1: required verification, review, and commit

- [x] Migrate `useGenerationSettingsDraft`
- [x] Remove the `stateRef.current = reduce(...)` mirror in `usePromptPresetEditorRuntime` and `useLorebookEditor` (use the reducer state / functional updates)
- [x] typecheck, lint, `bun run test`; drive generation settings, prompt preset editor and lorebook editor in the app with playwright-cli
- [x] Commit

## Acceptance

No request/version counter refs or ref mirrors remain in the three files.

## Outcome

**Removed:** Generation Settings draft/save request counters and the Conversation-id ref; the Prompt
Preset and Lorebook reducer-state mirrors. The form stays local, but pending writes belong to keyed
mutations and immutable submitted editor identities rather than numeric versions.

**Introduced:** `generation-settings-query.ts`, shared by the draft and composer ModelSelector, carrying
settings plus the Conversation revision internally. Reads consume the query signal, defer transport
one microtask for StrictMode, and fold authority at settlement. Writes cancel pending reads and publish
revision-checked authority; model selection publishes its committed revision then invalidates the same key.
Generation and Lorebook submissions capture a session cancellation signal; every completion checks it.
Prompt Preset uses query-owned recipe/library reads, functional reducer updates, and committed reducer
state through `useEffectEvent`. `flushSync` preserves its existing immediate claim/busy gate and
settle-before-selection contract without a second state owner. Lorebook cache updates reconcile saved
views across readers while preserving local drafts; key changes clear the previous book immediately.

**Behavior changed:** superseded reads abort; StrictMode and same-key readers share requests. Late saves
cannot update a new owner after unmount or A→B→A. ABA draft edits cannot report save-and-leave success.
Reconnect preserves local editors. Every reader sees authoritative writes without a manual reload.
Generation Settings still reads a fresh base before its full write to retain the composer's model choice.
A 409 adopts the current Conversation and settings while keeping every local draft field.

**Behavior constraint evidence:** tests use `src/client/test-fixtures/render-hook.ts` and real HTTP transport,
with deferred responses (no component snapshots or tautological architecture checks).

- **Latest wins:** `generation-settings-session.test.ts` — “switching Conversation aborts the old read and
  never adopts its late settings”; `editor-runtime.test.ts` — “Prompt Preset key switch aborts the previous
  recipe and rejects its late completion”, “Lorebook key switch aborts its old read and displays only the
  selected book”, and “Lorebook switching to a loading book clears the previous editor before another write
  can start”. “Lorebook StrictMode shares a read, reducer edits compose, and entry selection during save
  prevents the second write” covers changing the selected entry while a save is pending.
- **Abort:** those key-switch tests assert the captured HTTP `signal.aborted`; “Prompt Preset operation
  cancels a read it supersedes; the late recipe cannot replace the saved view” covers mutation supersession.
- **No duplicate fetch:** “StrictMode, 21 readers, rerenders and reconnect share one read; a panel save reaches
  every reader”, “Prompt Preset StrictMode and rerenders fetch once; reducer edits compose and operation
  settlement permits the next selection”, and the Lorebook StrictMode test assert exact read counts.
- **No resurrection:** Generation and Lorebook each test save settlement after unmount and A→B→A; Prompt
  Preset tests “unmount invalidates an operation claim and every late reducer dispatch”. “ABA edits during
  save preserve the newer draft and prevent save-and-leave success” rejects value-snapshot matching.
- **Optimistic revision:** the shared Generation read/save test asserts `expectedRevision: 5`; “409 adopts
  the current Conversation and settings for all readers while retaining the complete draft” asserts revision
  9 adoption, local instruction/sampling retention, conflict copy, and both readers' fresh settings.
  The Lorebook save/selection test asserts revision 1 on the book command and no stale entry command.
- **Cache freshness:** the 21-reader save test also mounts a later reader without another read; the 409 test
  checks conflict authority in every reader. “a late background read cannot roll back a newer authoritative
  write” checks cancelled HTTP and retained newer authority. “Lorebook writes reach every reader while
  retaining another editor's local draft” and “Prompt Preset refresh reaches another reader and retains its
  edited block” cover reducer views of shared caches. Infinite staleTime and explicit publication/refetch
  avoid implicit reads on mount/reconnect.
- **Cost:** the 21-reader test performs repeated renders plus a later mount: one initial GET, then exactly
  one fresh-base GET and one POST for the save. Prompt Preset performs one recipe GET and one library GET;
  Lorebook performs one book GET, independent of renders and entry lists.

**Code review:** independent Luna Standards and Spec reviews identified only the unfinished ticket
checkboxes/Outcome; those are filled here. No code findings on either axis. Rejected approaches remain
rejected: shared `useLatest`, value-snapshot ABA matching, state-ref mirrors, and unguarded late callbacks.

**Browser:** port 3000 was free. T3 preview open failed explicitly because AppArmor blocks its browser
sandbox; used the installed playwright-cli skill. Generation instruction saved, appeared after reopen,
and was restored. Prompt Preset enablement saved and was restored. Created a temporary Lorebook with
an entry, saved both in one action, reopened and verified saved content, and exercised the unsaved-close
confirmation. Browser console had five existing Vite font 403s, no React warnings/errors. Deleted the temporary Lorebook and its entry, closed the named browser,
removed `.playwright-cli/`, and stopped only the owned Bun server and Vite processes.

**Required verification (final source):**

- `bun run typecheck`: exit 0.
- `bun run lint`: exit 0; **343 existing warnings / 0 errors**. No new warnings.
- `bun run check:contracts`: exit 0; **632 structural declarations, 151 schema derivations,
  11 existing suspicious cross-layer matches**.
- `bun test src/client`: **320 pass / 0 fail / 1112 assertions across 32 files**.
- `bun run test`: **1396 pass / 0 fail / 5932 assertions across 159 files**.
- Targeted acceptance tests: **18 pass / 0 fail / 72 assertions across 2 files**.
- Final independent Luna Standards review: **0 findings**. Final Spec review: **0 findings**.
- `git diff --check`: clean. No request/version counter refs or reducer-state mirrors remain in the three
  owned hooks (FFF search returned 0 matches).

**Limits:** no e2e suite was run, as requested. No provider Generation was attempted; read/write and race
behavior is verified through actual hook transport with scripted HTTP responses. T3's native browser could
not be verified because of the AppArmor sandbox restriction; playwright-cli completed the manual checks.
Existing font 403s, lint warnings, and contract-audit matches remain outside this ticket.


### Review fix round 1

**Removed:** Prompt Preset draft value comparison for retirement; unguarded adoption of older
Generation and Lorebook command snapshots; unconditional Lorebook save-and-leave completion.

**Introduced:** accepted Generation Settings authority checks before form settlement, cached revision
checks before Conversation/Lorebook adoption, synchronous Lorebook reducer dispatch for interactions,
ModelSelector session cancellation and conflict invalidation, immutable submitted Prompt Preset draft
identity, and Lorebook leave-intent identity checks. Render-time Lorebook reducer calls remain pure.
No state-ref mirror or request/version counter was reintroduced; the shared query is unchanged.

**Behavior changed and committed regression evidence:** each new race test failed before its fix and
passed after. The eight added tests cover the seven findings (ModelSelector cancellation has two tests):

1. `generation-settings-session.test.ts` — “late panel save cannot replace a newer saved view”: revision 6
   settling after published revision 7 retains revision 7 settings, preserves the local dirty form, returns
   false, and does not notify the Conversation owner with revision 6.
2. `editor-runtime.test.ts` — “late save conflict cannot roll editor back behind cache”: a delayed revision 2
   conflict leaves both editors at revision 3.
3. `editor-runtime.test.ts` — “pending save sees entry selection queued before result”: selecting an entry
   and resolving the first save in one act prevents the second POST and returns false.
4. `generation-settings-session.test.ts` — “ModelSelector conflict refreshes cached settings for later
   readers”: a 409 adopts revision 9 and reopening reads the server model from the shared cache.
5. `generation-settings-session.test.ts` — “ModelSelector pending write cannot publish after unmount” and
   “ModelSelector key switch rejects old Conversation completion”: late writes cannot notify the owner or
   publish the selected model after cancellation. The runner guards adoption/notices/callbacks and the
   selector guards pending cleanup using the captured session signal.
6. `editor-runtime.test.ts` — “Prompt Preset ABA edits cannot close the editor”: Submitted→Other→Submitted
   keeps the later draft identity and prevents save-and-leave closing. Existing retirement tests now submit
   the reducer-owned draft identity, as the real hook does.
7. `editor-runtime.test.ts` — “Lorebook save-and-leave preserves a replacement leave intent and does not
   navigate”: invokes the actual dialog handlers; the old save neither closes the new confirmation nor
   runs captured navigation, even when the replacement intent has identical values.

Existing latest-wins, signal abort, StrictMode deduplication, cross-reader freshness, optimistic revision,
and request-cost tests remain passing. No browser or e2e was run for this behavior-only review fix.
No shared server process was touched. Concurrent T9c paths were neither edited nor staged.

**Review:** gpt-6.1-sol Standards **0 findings**; gpt-6.1-sol Spec **0 findings**.

**Verification:**

- Targeted hook/reducer suites: **52 pass / 0 fail / 148 assertions across 3 files**.
- `bun run typecheck`: exit 0.
- `bun run lint`: exit 0; **343 warnings / 0 errors**, no new warnings.
- `bun run check:contracts`: exit 0; **632 structural declarations, 151 schema derivations,
  11 existing suspicious cross-layer matches**.
- `bun test src/client`: **344 pass / 0 fail / 1186 assertions across 33 files**.
- `bun run test`: **1420 pass / 0 fail / 6006 assertions across 160 files**.
- `git diff --check`: clean. Deleted `/tmp/t9b-review`.

Counts include the concurrent T9c changes present during verification. Existing lint warnings and
contract-audit matches remain outside this fix. No residual findings from this review round.
