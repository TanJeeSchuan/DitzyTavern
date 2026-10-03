# stream-eyes

Tools for watching the streaming text animation in `src/client/story/prose.tsx` without a human looking at the screen. They run one real generation in headless Chromium against a fake model, record what happened, and turn it into numbers and images.

I built these to answer one question. Does every chunk of streamed text actually fade in? The first run found a chunk that didn't, and `bb4f62c` fixes it.

## Requirements

- A built client. Run `bun run build` first, the server serves `dist/`.
- Node for `eyes.mjs`. Bun's child process pipes hang Playwright's Chromium launch.
- Python with numpy and Pillow for `analyze.py` and `viz.py`.

## Quick start

```sh
bun run build
VH=1500 node scripts/stream-eyes/eyes.mjs trace 800 .scratch/run
python scripts/stream-eyes/analyze.py .scratch/run
VH=1500 python scripts/stream-eyes/viz.py .scratch/run
```

Put output under `.scratch/`. It's gitignored, and a run writes a few hundred PNG frames.

## The pieces

`server.ts` is a copy of `scripts/screenshot-server.ts` with a slower fake model. It seeds a fresh database and streams about 1,800 characters of fixed prose, 4 characters per delta, at `CPS` characters per second (default 400). The second paragraph is 834 characters long on purpose, so one paragraph spans more than one reveal chunk. You don't start it yourself. `eyes.mjs` starts a fresh one per run on a random port and kills it at the end.

`eyes.mjs <mode> <cps> <out>` opens the seeded chat, sends a message, clicks through the Prompt Plan preview, and records the generation. `VH` sets the viewport height (default 900).

- `trace` mode waits for the full reply and writes `trace.json` plus `frames/`, a 60fps CDP screencast. The trace holds:
  - every reveal span added inside a `.prose-block`, with its age and last animation progress when removed
  - every DOM mutation inside a `.prose-block`
  - every SSE read the browser received, with byte count and number of content events
  - one sample per animation frame with each live reveal's animation progress and the rectangles of the streaming message and its blocks
- `scrub` mode waits for the second paragraph to mount, reads its animation keyframes into `animations.json`, then sets its animations' `currentTime` to 0, 100, ... 600ms and screenshots the block at each step into `frames/scrub-*.png`. Use a slow speed like 150 so the next chunk doesn't land mid-scrub.

`preview.html` is for watching by eye. It renders the app's own `StoryMessageView`, `Prose`, `GenerationControls`, follow-scroll hook and CSS, and streams the reply from a local timer instead of a server. Start `bunx vite` and open `http://127.0.0.1:5173/scripts/stream-eyes/preview.html`. The panel sets speed, first-token latency, theme and the reply text, and has Replay, Pause, and the real Stop button. Edits to the app code hot-reload into it.

`analyze.py <out>` prints the trace as a timeline. A line ending in `SNAP` is a reveal removed before its animation finished, which the eye sees as text popping in. The summary counts snaps, gaps between reveals, and rAF frames longer than 34ms.

`viz.py <out>` renders images into the same folder. Pass the same `VH` you recorded with, since it sets the crop.

- `filmstrip.png` has 12 frames spread across the stream.
- `arrival.png` colors each pixel by when it reached its final value and held it for 200ms, blue early and orange late. Frames are aligned to the streaming message, so each reveal chunk shows up as one flat band of color.
- `fade-<n>.png` has one row per reveal span, showing the block that received it from 100ms before insertion to 600ms after. A working reveal shows the soft edge sweeping through the lines. A snap goes straight to dark.

## Reading the results

With the current code, expect 0 snaps at any speed and 8 reveals. Apart from the first and last, chunks run 185 to 284 characters. The first is the opening 59-character sentence. `revealedLength` makes a reveal due after the first 80 characters, then each time another 300 have streamed, and shows up to the latest sentence end before that point. A sentence end must be followed by whitespace, so the last sentence waits for the stream to end.

Each reveal wipes in through a mask with a soft edge 6em wide, moving 2.5ms per character, so a 280-character chunk takes about 700ms. Markup splits a reveal into one span per text node, each with its own animation, and each span's delay starts it when the edge reaches its first character. Since every node gets a span, `analyze.py` counts more spans than reveals.

## Known traps

- Use a tall viewport for `arrival.png`. With the default 900px the chat scrolls during the stream, and the map turns to mush. 1500 fits the whole reply.
- On Windows, timers fire every ~15.6ms. The server only sleeps when it is ahead of schedule, so speeds above ~250 CPS still work. If reveal timing stops scaling with `CPS`, check this first.
- Screencast timestamps trail the trace clock by about one frame. For exact timing, trust the opacity samples in `trace.json` over the frame labels.
- The fixture server occasionally fails to start. Rerun. The Elysia `exactMirror` message it prints is unrelated and shows up in good runs too.
- The prose and the "done" marker are hardcoded. `eyes.mjs` waits for the text `patience than with words.`, so update both if you change the prose.
