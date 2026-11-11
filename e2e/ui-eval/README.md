# Run the UI responsiveness eval

Run `bun run test:ui-eval`. The command uses the same remote executor as `test:e2e` when configured. On this shared host, use the PR's `ui-eval` CI job instead of running the suite locally.

The suite runs serially against the production build, with normal motion and a desktop viewport. It uses the existing seeded database and scripted provider fixtures.

Read `.scratch/ui-eval/summary.md` or the CI job summary. Raw samples are in `.scratch/ui-eval/samples.json`. CI uploads both the report and Playwright's test attachments as the `ui-eval` artifact.

Budget misses are informational while collecting a baseline. The job fails for incorrect output, missing measurement origins, malformed observed SSE, or a probe that misses the injected stall. It does not mark missing text as a successful response: a timeout is an explicit budget miss with a lower bound, excluded from completed-sample statistics.

## Interpret the scenarios

- Stalled streaming sends a short sentence, CJK text, or a short second paragraph, then holds the provider open. Timing starts when the browser probe receives the matching content or state snapshot. The endpoint is the expected plain text mounted in active prose. Each case observes for 1500 ms against a 400 ms budget. Stop then verifies that the withheld content survives.
- Swipe uses five Variants containing long Markdown. Each repetition reloads the page to clear browser query caches. The target is three Swipes away. A gate in that browser document keeps its fetch pending through adjacent prefetch and releases it on the measured click, before the network request starts. The expected destination text must mount in the message's prose. Each browser document owns its gate and releases it locally.
- Stop runs against a held reply. The endpoint requires an enabled Generate Variant button and an editable composer. The text flushed after Stop does not count as a failure.
- Typing checks whether the composer is editable while provider chunks arrive every 80 ms. The app currently disables it during generation, so the report marks this scenario unavailable with zero latency samples. When typing is available, it sends real keys and verifies that multiple arrivals overlap the samples. The target is 50 ms per key. Swipe and Stop use 400 ms.

Swipe, Stop and available typing each collect 20 samples after one warmup. Stalled cases run once each. The summary reports completed medians, completed maxima, timeout lower bounds, budget misses and unavailable scenarios. Do not interpret a median of completed samples without the timeout count.

## Understand the clock

The init script captures trusted click and keydown `event.timeStamp` values. A DOM observer checks the expected text or enabled controls. After that condition holds, a `requestAnimationFrame` followed by a MessageChannel callback records a render opportunity. Playwright locator polling is outside the measured endpoint.

These values are presentation estimates. They do not prove that pixels reached a display. The probe checks visibility but does not measure text masks, wipe completion, physical input latency or display latency. Stream timing uses a cloned response reader, which can run at a different scheduling point than the application's reader. It separates provider waiting from client handling without claiming an exact network arrival timestamp.

The 500 ms busy-loop case verifies that work before the editor processes a key remains in the measured interval. It is excluded from app statistics.

The 400 ms budget applies Doherty's command-turnaround guideline to app-controlled work. It is not a perceptual boundary. Typing has a separate, tighter budget. Observe variance across CI runs before introducing mandatory timing gates, and retain timeout counts when choosing them.
