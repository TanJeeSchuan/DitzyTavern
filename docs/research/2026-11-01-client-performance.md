# Client performance, 1 November 2026

Measured against `1f5cfe3` and the working-tree fixes. The largest existing Chat has 1,433 Messages. Profiling used isolated SQLite copies and a scripted local provider; the user's database was not changed.

## Results

Medians of three runs per version, using normal minified production builds, fresh Chromium instances, a 1440 × 900 viewport, and no CPU throttling. CPU sampling was disabled for these comparison runs. The earlier CPU profiles used production React with unminified bundles to identify functions.

| Workload and measurement | Before | After |
| --- | ---: | ---: |
| Load history from 250 to 500 Messages: blocking time | 742 ms | 0 ms |
| Load history from 500 to 1,000 Messages: blocking time | 2,171 ms | 30 ms |
| Same 500-to-1,000 load: longest task | 294 ms | 70 ms |
| Same load: JavaScript execution | 2,023 ms | 760 ms |
| Same load: layout plus style recalculation | 957 ms | 31 ms |
| Stream 1,200 tokens with 1,000 mounted Messages: JavaScript execution | 5,913 ms | 2,568 ms |
| Same stream: 95th percentile frame interval | 33.3 ms | 16.8 ms |
| Same stream: longest task | 271 ms | 215 ms |
| Following 1.5-second idle period: longest task | 229 ms | 0 ms |
| Retained JavaScript heap after that idle period | 79.9 MiB | 69.6 MiB |

Blocking time is the sum of each task's duration above 50 ms. Zero means no task crossed that threshold, not zero CPU work. History rows describe a sequence of page loads, not a single click. Heap measurements follow explicit garbage collection and exclude the browser's native memory, decoded images, and GPU allocations.

The fake provider emits 1,200 short tokens at a requested 5 ms interval. It removes provider/network variance and charges client processing to the client, but does not measure real provider latency or background Memory extraction. Phase wall times include intentional settling waits and are not reported as interaction latency. Performance counters reset on navigation, so negative counter deltas from the reload phase are excluded. Frame maxima can include a boundary pause from explicit garbage collection; the table uses frame percentiles instead.

## Causes and fixes

1. **History refreshes rebuilt unchanged Messages.** Every window projection created new objects, defeating row memoization. It also found each previous Message by scanning the full array. The reducer now indexes previous Messages once and uses TanStack's existing `replaceEqualDeep` to retain unchanged rows and nested values.
2. **Closed Swipe browsers created query observers for every Variant.** Disabling a query prevented fetching but retained its observer. Closed browsers now pass an empty query list. A regression test verifies zero observers while closed, loading on open, release on close, and cached text on reopening. It failed with two retained observers before the fix.
3. **Token arrival dictated rendering speed.** The production stream adapter now delivers observations in 16 ms batches. It preserves event order and flushes before snapshots and settlement, including truncated streams. Aborted subscriptions discard queued events. A regression test failed when the view saw one event from a burst before the others; it now sees the burst together. The resume test also checks event-before-snapshot ordering.
4. **Streaming repeatedly measured an unchanged history anchor.** The viewport skips the anchor layout read when the first and last Message identities are unchanged. Swipe scrolling still runs independently.
5. **Offscreen Messages paid full rendering costs.** Message rows now use `content-visibility: auto` with a remembered intrinsic size and a 500 px initial estimate. This retains the DOM and browser search while allowing offscreen layout and painting to be skipped. Existing reading-anchor, smooth-scroll, tall-Swipe, keyboard, and touch flows passed.

No dependency or server behavior changed.

## Additional stress

- Scrolled between the top and bottom repeatedly at 250, 500, and 1,000 loaded Messages. The final minified runs recorded no long tasks in these scroll phases.
- Typed into the composer with 1,000 Messages mounted. Both versions recorded no long tasks; this path was already reasonably isolated.
- Opened and closed Chats, Characters, Lorebooks, Prompt Presets, Connections, Generation, Boxes, and Settings for 12 cycles, totaling 96 panel visits. No post-startup long task was recorded. Retained DOM nodes stayed at 7,236 and event listeners settled at 2,039. Heap rose from 10.1 to 13.2 MiB, including warmed caches; this short run does not establish a long-term heap plateau.
- Created a temporary Message with 50 substantial Variants in the isolated database, opened and closed the Swipe fan eight times, and sent 160 arrow-key navigation actions. The worst recorded task was 81 ms. After closing, DOM nodes returned to 7,244; heap settled around 11.0 MiB versus 10.2 MiB before opening, and listeners increased by three. No browser exception occurred.

## Remaining limits

At 1,000 loaded Messages the client still retains roughly 87,500 elements and 62.8 MiB of JavaScript heap before streaming. Content visibility reduces rendering work; it does not bound DOM or state growth. Fully bounding this would require a history-window or virtualization change that preserves reading anchors, browser search, focus, and Swipe state.

Starting and settling a Generation can still produce approximately 200 ms tasks with that much history mounted. Streaming throughput and sustained frame pacing improved substantially, but these boundary spikes remain. Cold opening also still has roughly 90 ms tasks in the measured desktop environment. Large initial JavaScript chunks remain a build warning.

These are desktop Chromium measurements. The browser flows include narrow layouts and touch input, but mobile hardware performance and other browser engines were not profiled.

## Validation and artifacts

- 337 client tests passed, including both new regression tests.
- 35 selected Playwright flows passed: generation, requested state, restart recovery, pagination anchoring, source jumps, multi-tab sync, Swipe fan/modal, lazy Variant text, composer recession, and touch navigation.
- Typecheck, lint, production build, and `git diff --check` passed. Lint reported existing warnings; the build still warns about large chunks.
- Raw results, CPU profiles, logs, and the local stress scripts are in `D:/Tmp/ditzy-client-perf/`. The comparison inputs are `prod-before-{1,2,3}/results.json` and `prod-after-{1,2,3}/results.json`; `summary.json` contains their medians. `panels.json` contains the additional interaction samples.
- `stress.mjs` selects Chat 8 in the workspace response, loads through 1,000 Messages, scrolls, types, streams a reply, idles, and reloads. Run it with `node D:/Tmp/ditzy-client-perf/stress.mjs <run-name> --no-cpu` against the isolated fake-provider server on port 3100. The temporary `serve.ts` is adapted from the repository's `scripts/profile-actions.ts` to keep profiling data under `D:/Tmp`.

Profiling servers were stopped after verification.
