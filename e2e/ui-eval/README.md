# Run the UI responsiveness eval

Run `bun run test:ui-eval`. The command uses the same remote executor as `test:e2e` when configured. On this shared host, use the PR's `ui-eval` CI job instead of running the suite locally.

The suite runs serially against the production build, with normal motion and a desktop viewport. It uses the existing seeded database and scripted provider fixtures.

Set `UI_EVAL_LATENCY_MS=100 bun run test:ui-eval` to emulate network latency. The setting is forwarded to the remote executor and printed in the report; it defaults to zero and accepts finite, nonnegative milliseconds. Chromium applies it only to browser `/api/` requests at the test server's origin, including its random port. Assets, fixture API calls and server-side provider calls are unaffected; bandwidth is unrestricted. The value is a minimum request-to-response-headers duration, not an extra delay added to server processing time. It delays stream connection setup, not every streamed chunk. This requires Chromium's CDP network emulation.

For a focused comparison, run `UI_EVAL_LATENCY_MS=100 bun run test:ui-eval --grep 'crawl Prompt Preset controls'`. Draft toggles and already-loaded entry details should remain fast, while opening uncached panels and saving include network time. A separate validation case fetches real workspace data and checks a known 250 ms latency floor, regardless of the configured eval setting.

Read `.scratch/ui-eval/summary.md` or the CI job summary. Raw samples are in `.scratch/ui-eval/samples.json`. CI uploads both the report and Playwright's test attachments as the `ui-eval` artifact.

Budget misses are informational while collecting a baseline. The job fails for incorrect output, missing measurement origins, malformed observed SSE, or a probe that misses the injected stall. It does not mark missing text as a successful response: a timeout is an explicit budget miss with a lower bound, excluded from completed-sample statistics.

## Interpret the scenarios

- Stalled streaming sends a short sentence, CJK text, or a short second paragraph, then holds the provider open. Timing starts when the browser probe receives the matching content or state snapshot. The endpoint is the expected plain text mounted in active prose. Each case observes for 1500 ms against a 400 ms budget. Stop then verifies that the withheld content survives.
- Swipe uses five Variants containing long Markdown. Each repetition reloads the page to clear browser query caches. The target is three Swipes away. A gate in that browser document keeps its fetch pending through adjacent prefetch and releases it on the measured click, before the network request starts. The expected destination text must mount in the message's prose. Each browser document owns its gate and releases it locally.
- Stop runs against a held reply. The endpoint requires an enabled Generate Variant button and an editable composer. The text flushed after Stop does not count as a failure.
- Typing checks whether the composer is editable while provider chunks arrive every 80 ms. The app currently disables it during generation, so the report marks this scenario unavailable with zero latency samples. When typing is available, it sends real keys and verifies that multiple arrivals overlap the samples. The target is 50 ms per key. Swipe and Stop use 400 ms.

Swipe, Stop and available typing each collect 20 samples after one warmup. Stalled cases run once each. The summary reports completed medians, completed maxima, timeout lower bounds, budget misses and unavailable scenarios. Do not interpret a median of completed samples without the timeout count.

## Crawl Prompt Preset controls

Run `bun run test:ui-eval --grep 'crawl Prompt Preset controls'` to run the pilot. It discovers visible controls through Playwright roles and accessible names in the Prompt Presets panel, then sorts stable keys built from the state, entry position and control identity. It opens discovered entry editors and inventories their controls one level deep.

Each case resets the seeded database and reloads the page. Every discovered entry switch is exercised in both directions, with three samples per direction. The draft endpoint requires the new checked state and the panel's Unsaved changes status. Save has its own timing and verifies the persisted entry through the API. Entry details require populated content and usable controls, followed by an immediate identity check against the originating row. Opening the panel is also timed on every reset.

The control inventory is attached even when a case fails. `coverage.json` and `coverage.md` list every discovered control, its completion rule and sample count. Controls outside the pilot's rules remain explicitly unmeasured. This is a bounded panel crawl, not exploration of every setting combination. New matching switches and entry editors are included automatically.

## Understand the clock

The init script captures trusted click and keydown `event.timeStamp` values. During a measurement, it checks the expected text or enabled controls on render frames so CSS visibility changes count even without another DOM mutation. After that condition holds, a MessageChannel callback records a render opportunity. Playwright locator polling is outside the measured endpoint.

These values are presentation estimates. They do not prove that pixels reached a display. The probe checks visibility but does not measure text masks, wipe completion, physical input latency or display latency. Stream timing uses a cloned response reader, which can run at a different scheduling point than the application's reader. It separates provider waiting from client handling without claiming an exact network arrival timestamp.

The 500 ms busy-loop case verifies that work before the editor processes a key remains in the measured interval. It is excluded from app statistics.

The 400 ms budget applies Doherty's command-turnaround guideline to app-controlled work. It is not a perceptual boundary. Typing has a separate, tighter budget. Observe variance across CI runs before introducing mandatory timing gates, and retain timeout counts when choosing them.
