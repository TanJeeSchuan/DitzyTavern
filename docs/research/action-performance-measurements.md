# App action measurements

2026-10-30 · master `985c40c3` and PR #134 · Bun 1.4.4

These measurements test the [action audit](action-performance-audit.md) against a `VACUUM INTO` copy of the chat2.tanjs.uk database. `scripts/profile-actions.ts` drives the app's routes in process, and a local fake answers every provider call after a fixed delay. Bun's CPU profiler (`--cpu-prof-md`) runs over the whole session.

```sh
bun --env-file=/srv/DitzyTavern/.env run profile:actions /srv/DitzyTavern/data/ditzytavern.sqlite --latency=300
```

For the browser, build an unminified client and serve the copy, then drive it:

```sh
bunx vite build --minify false
bun --env-file=/srv/DitzyTavern/.env scripts/profile-actions.ts /srv/DitzyTavern/data/ditzytavern.sqlite --serve=3100 --token-ms=20
bun run profile:browser http://127.0.0.1:3100/
```

The report and the Markdown CPU profile go to `.scratch/profile/`. Options: `--chat=<id>` (default: the Chat with the most Messages), `--latency=<ms>` per provider call, `--tokens=<n>` streamed per reply, `--repeat=<n>`, and `--cold-embeddings`, which empties the embedding cache before every timed run.

## The data

The largest Chat has 1,447 Messages and 2,783 Variants. Its selected path holds 2.38 MB of prose, about 563k estimated tokens, and its context limit is 102,768 tokens. Memory recall ranks about 2,400 cached 3,072-dimension claim vectors. The database has no Lorebook entries.

Stored Variant data, largest first:

| Namespace / key | Rows | Total | Largest |
| --- | ---: | ---: | ---: |
| `generation-box` / `traces` | 216 | 16.5 MB | 93 KB |
| `import.sillytavern` / `variant.reasoning.text` | 1,940 | 4.9 MB | 97 KB |
| `box:memory` records | 954 | 2.1 MB | 11 KB |
| `generation` / `reasoning` | 694 | 1.3 MB | 30 KB |
| `lore-activation` / `record` | 727 | 132 KB | 181 B |

The largest Box trace is almost all Memory recall: 58 KB of judged candidates and a 12 KB scene, kept on every Variant.

## Results

300 ms provider latency, warm embedding cache, median of 3 runs (Send, Swipe and Fork run once):

| Action | master ms | PR #134 ms | Provider calls on master (start→end ms) |
| --- | ---: | ---: | --- |
| Open history page | 7 | 6 | none |
| Box window: Memory (449 KB) | 80 | 78 | none |
| Inspect prompt (Send) | 1,339 | 1,351 | embeddings 70→370, decision 393→693 |
| Send to settled | 1,829 | 2,123 | embeddings 75→376, decision 398→698, chat 1,465→1,815 |
| Swipe to settled | 1,764 | 1,768 | embeddings 75→376, decision 393→694, chat 1,395→1,753 |
| Fork through latest | 1,311 | 1,202 | none |

Cold embedding cache:

| Action | master ms | PR #134 ms |
| --- | ---: | ---: |
| Inspect prompt (Send) | 1,646 | 1,338 |
| Send to settled | 2,165 | 1,798 |
| Swipe to settled | 2,441 | 2,231 |

On master, the two embedding requests run one after the other (68→368, then 378→679). PR #134 starts them together (69→369 and 69→370), which saves one provider round trip whenever claims miss the cache. With a warm cache only the scene is embedded, so the PR changes nothing measurable there. Single-run rows, such as Send, vary by about ±300 ms between runs.

Startup on this database: open and migrate 130–220 ms, load Boxes 70–90 ms, recover Generations under 10 ms, image sweep 120–140 ms.

## Where the time goes

**History budgeting is the largest local cost.** After the Memory judge answers at about 700 ms, the chat request starts about 770 ms later. In the CPU profile, `budgetPromptPlan` → `measurePromptPlan` → tokenx `estimateTokenCount` accounts for 4.0 s of the 9.6 s session. That is about 580 ms on each of the seven captures. The binary search first estimates the whole 2.4 MB transcript, then halves toward the roughly 0.4 MB window that fits. That comes to about 7 MB of tokenx scanning per capture, at about 90 ns per character. The other compile work, including dynamic admission at 290 ms in total, is small next to it.

**Fork costs about 1.2 s, almost all in per-row inserts.** The route spends 1.0 s inside its transaction. Most of that goes to Drizzle building and preparing one INSERT statement per copied row (`prepare` 266 ms, `buildQueryFromSourceParams` 574 ms), not to SQLite I/O.

**The Memory window answers 449 KB in 80 ms.** Each change-feed revalidation recomputes it.

The profile also charges 1.19 s of self time to `bootstrapConnectionSecretKey`, but the function takes 0.5 ms when timed alone. Read a hot function's self time with care unless the call tree supports it.

## What this changes in the audit

- **1 (overlap embeddings):** confirmed. It saves one provider round trip on a cold cache and nothing on a warm one.
- **2 (narrow history reads) and 3 (single import read):** no measurable change on this data. They stay as small cleanups.
- **6 (Lore evidence):** this data has no Lore. Box traces are what grows here: 16.5 MB across 216 Variants, mostly Memory recall candidates.
- **8 (compile stable prompt parts once):** the audit wanted measured evidence before acting, and this is it. Estimating history costs about 580 ms per Send, Swipe or Inspect on a long Chat. That is longer than either provider round trip in front of it.
- **10 (bulk fork copy):** measured at 1.2 s for the largest Chat, and the cost is statement preparation.

## Follow-up: history estimate cache (PR #135)

PR #135 estimates a Prompt Plan as the sum of cached per-block estimates. Zero provider latency, longest Chat:

| Action | master | PR #135 |
| --- | ---: | ---: |
| Inspect prompt (Send) | 711 ms | 161 ms |
| Send to settled | 941 ms | 347 ms |
| Swipe to settled | 894 ms | 252 ms |

## Other hot spots

The active Chat (517 Messages, 966 Variants, 0.8 MB of prose) was measured on master with zero provider latency. Reads such as workspace, Chat summary, Character list, history page, Variant text, select and edit each take under 25 ms.

**Fork takes 3.0 s on the active Chat.** 2.2 s of that is `rewriteRowReferences` walking the Chat's 16.9 MB of Box traces leaf by leaf. Subtrees that hold no Row Reference get walked anyway, and every leaf it cannot classify runs `JSON.stringify(schema)` (`row-references.ts:45`). The other ~0.6 s is Drizzle building and preparing one INSERT per copied row. Fix: remember per schema node whether its subtree holds a Row Reference, and return reference-free values untouched.

**The Memory window answers 1.08 MB in 57 ms on the active Chat.** `excerpt` runs its markup regexes over each Message's full text before keeping 240 characters (`digest.ts:331`). The change feed recomputes the window on every tick of a catch-up.

**Startup** spends 130–290 ms opening and migrating the database and 106–140 ms in the image sweep.

### Browser

Unminified build, headless Chromium, active Chat with a 50-Message page, 20 ms per streamed token:

| Phase | Wall | Long tasks |
| --- | ---: | --- |
| Open the latest Chat | 1.0–1.5 s | 3–4, totalling 470–650 ms, longest 330 ms |
| Send through the Prompt Plan preview and stream 400 tokens | 11.2 s | 4–5, totalling 1.3 s, longest 800 ms |
| New Swipe and stream 400 tokens | 11.1 s | 3–4, totalling 1.1–1.25 s, longest 780 ms |
| Browse to the previous Swipe | 100 ms | none |

**Streaming keeps the main thread 82% busy** (4.9 s of 6 s mid-stream). Every streamed event re-renders every `StoryMessageView` on the page through a synchronous React commit, including its lucide icons and `formatTimestamp`. This is audit item 9, now measured: memoize settled rows with stable props, and publish streamed text once per animation frame.

**Opening the Prompt Plan preview is the 700–800 ms long task.** `PromptPlanPreviewPanel` mounts a CodeMirror `EditorView` for every block, including the history blocks inside the collapsed "History · N messages" `<details>`. That is 680 ms of editor construction for blocks nobody has opened. Mount a block's editor only when its `<details>` is open.

The server uses 3.55 s of CPU over the 25.7 s browser session (14%), including two plan captures.

**Profiler caveat.** Bun's Markdown profile charges idle time to whichever function was sampled last. On a mostly idle served process it reported multi-second self times that the process's CPU time contradicts. Trust it only for busy runs, and check against `/proc/<pid>/stat` or a direct timer.

## Outcome

Merged into master on 2026-10-30 as one stack, bottom to top:

| PR | Change | Measured effect |
| --- | --- | --- |
| #134 | Scene and claim embeddings run together, and a failing one cancels the other. Semantic Lore uses two workers. Import reads the staged file once. History derives `empty`/`hasReasoning` in SQL. | One provider round trip less on a cold embedding cache. The rest is below measurement on this data. |
| #135 | A Prompt Plan's estimate is the sum of cached per-block estimates. | Send to settled: 941 → 347 ms, longest Chat, 0 ms latency. |
| #136 | Fork skips reference-free Box values and reuses prepared statements. | Fork of the active Chat: 3.0 → 1.77 s. |
| #137 | Memoized Message rows with stable handlers, and a stable `requestNavigation`. | Main thread while streaming: 82% → 38% busy. |
| #138 | History editors in the Prompt Plan preview mount when their run first opens. | Longest task on Send: ~800 → 184 ms. |

Tried and dropped:

- **Lazy Reasoning `Collapsible` and `content-visibility: auto` on Messages, for opening a Chat.** In four runs each, both were within noise of master (main thread busy 648–704 ms against 665–703 ms). Removing Radix's measurement moves the forced layout to `useStoryViewport`'s `messageTop`. Opening a Chat costs React committing 50 Messages plus the page's first layout. A smaller first page is the remaining lever.
- **Cleaning a bounded prefix for Memory window excerpts (#139, closed).** It saved 3 ms per read, but a tag crossing the cut, or a whitespace-heavy prefix, changes the excerpt.

## Box traces

A Box trace (`generation-box` / `traces` Variant data) is what each captured Box contributed to one Generation. It holds the Box's own `trace`, the host's admission of each item, and the Box block's text as budgeted (`automaticText`) and as sent (`finalText`). It is written when a Generation is accepted, read only by Generation details and the Prompt Plan preview (`BoxTraceViews`), and copied by fork.

On chat2 (2026-10-31), 277 Variants carry 21.4 MB of traces:

| Part | MB |
| --- | ---: |
| Memory `trace.candidates` | 15.0 |
| Author Note items and texts | 2.3 |
| Memory `trace.scene` | 1.9 |
| Memory items and texts | 1.9 |
| Everything else | 0.3 |

Memory's trace records every candidate recall considered: about 60 per Generation (the semantic top 48 plus the 16 most recent, deduplicated), 16,720 in total. Each candidate copies its claim, attribution, people and up to three evidence excerpts from the Memory record it came from, plus ranks and the Decision Model's score. 2,600 of them (16%) were admitted. The view shows them all under "Considered claims (N)", collapsed by default.

Each Variant's trace stores a full copy of what its Memory records already hold, plus the 12 KB scan scene. Three ways to shrink it, each a choice about what the inspector keeps:

1. **Reference the claims instead of copying them.** Store the identity, ranks, score and admission, and read the claim text and evidence from the Memory records when the trace is opened. This cuts about 9 MB of the 15. A trace whose source record was later corrected or reset would then show the current claim, so the view would have to label it.
2. **Keep full detail only for admitted and near-miss candidates.** Count the rest. The inspector loses the long tail of irrelevant claims.
3. **Drop `scene`.** It can be rebuilt from `scanMessageIds` as long as those Messages are unchanged.
