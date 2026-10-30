# App action measurements

2026-10-30 · master `985c40c3` and PR #134 · Bun 1.4.4

These measurements test the [action audit](action-performance-audit.md) against a `VACUUM INTO` copy of the chat2.tanjs.uk database. `scripts/profile-actions.ts` drives the app's routes in process, and a local fake answers every provider call after a fixed delay. Bun's CPU profiler (`--cpu-prof-md`) runs over the whole session.

```sh
bun --env-file=/srv/DitzyTavern/.env run profile:actions /srv/DitzyTavern/data/ditzytavern.sqlite --latency=300
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
