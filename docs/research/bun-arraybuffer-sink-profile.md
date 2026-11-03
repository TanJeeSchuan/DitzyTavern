# Bun.ArrayBufferSink profile

2026-10-25 · source `5c33cd129a17b270eba0858997a703a910a9e6b6` · Bun 1.4.4 · Linux x86_64 · Intel i5-4460, four cores.

## Verdict

**Keep the current reader.** The sink saves 12 physical application lines but provides no measurable speedup on the production-derived payloads at concurrency 1. Eight concurrent large embedding requests regress 8.6%; even preallocating the entire response cap regresses 4.3%. No application or deployment code was changed.

This profiles the proposal in the Bun ecosystem audit: replace the chunk array and `joinBytes` in `src/server/model-client/model-fetch.ts` with a capped native sink. It does not affect chat streaming, which uses a separate path.

## Production sample

Opened `/srv/DitzyTavern/data/ditzytavern.sqlite` with `bun:sqlite` `{ readonly: true }`, serialized a consistent snapshot into a private temporary directory, then closed the production connection. All benchmark queries and HTTP traffic used the local snapshot and a loopback fake provider.

- Embedding cache: **2,066 vectors**; 133 × 1,024 dimensions and 1,933 × 3,072 dimensions.
- Saved discovery catalogs: **37, 33, and 13 models**.
- Saved Memory traces: **30**, containing 55–61 candidates; used the median (59) and largest (61) candidate counts and their stored scores.

The DB does not retain original embedding HTTP JSON, provider chunk boundaries, or complete Decision Model response bodies. Embeddings were reconstructed from the cached Float32 values, so their decimal precision can differ from the original provider JSON. Discovery uses stored IDs without unstored provider metadata. Decision payloads are compact score answers reconstructed from trace scores, with empty probability objects; they pass the generic Decision client but are not a replay of Memory probability validation. Batches of 1, 16, and 64 embeddings are selected scenarios, not measured historical batch-frequency statistics.

No production endpoint, credential, prompt, or provider API was used. Input strings for replayed embedding requests are neutral placeholders; this measures the response/client path, not model computation or a complete Memory recall.

## Method

The [harness](bun-arraybuffer-sink-profile.mjs) builds four otherwise identical copies of the actual `discoverModels`, `requestEmbeddings`, and `requestDecisions` clients, swapping only `model-fetch.ts` during bundling:

1. Current chunk-array reader and `joinBytes`.
2. Default `Bun.ArrayBufferSink` with each write sliced to the remaining cap.
3. Sink with `highWaterMark = min(maxBytes, 64 KiB)`.
4. Sink with `highWaterMark = maxBytes` (up to 16 MiB of initial embedding-buffer capacity).

The type-correct candidate leaves sink output as an ArrayBuffer and wraps `sink.end()` with `new Uint8Array(...)`. This creates a view over the default ArrayBuffer output. The screenshot’s `asUint8Array: true` formulation returns a union in the installed Bun declarations, so directly returning `sink.end()` does not satisfy the existing return type. No cast, wrapper API, or compatibility path was added.

Each case has **7 samples per implementation**, with alternating forward/reverse implementation order, both sides warmed before calibration, and common iteration counts per case. Calibration targets 120 ms per sample (minimum three iterations; the eight-request batch therefore runs longer). GC runs outside each timed sample. Results below are median **[minimum–maximum]**, in milliseconds. Full sample values and iteration counts are in [the raw results](bun-arraybuffer-sink-profile.results.json).

Reader-only cases include Response/ReadableStream creation, reads, the existing abort race/listeners, accumulation, cancellation/cleanup, and byte-count/sentinel assertions. Chunks are 16 KiB. Full-client cases use real loopback HTTP, deadline setup, the actual response reader, UTF-8 decoding, JSON parsing, schema validation, and client postprocessing. Full output comparisons run before timing; timed loops assert success, counts, dimensions, and an embedding sentinel. Server-request and completed-operation counts are retained. The server runs in the same process as the clients, so concurrency results include its work.

Machine load average was 0.66/0.54/0.75 before initial measurements and approximately 0.9–1.4 during production runs, on four cores. Timed implementations ran sequentially; profiles ran separately. This is a live host with other services, so small overlapping differences are treated as inconclusive.

## Actual clients with production-derived responses

| Scenario | Current, ms | Default sink, ms | Change in median |
| --- | ---: | ---: | ---: |
| catalog-37models-846B | 0.148 [0.140–0.160] | 0.147 [0.142–0.160] | -0.8% |
| catalog-33models-1259B | 0.148 [0.142–0.155] | 0.148 [0.140–0.154] | +0.1% |
| catalog-13models-413B | 0.112 [0.109–0.126] | 0.113 [0.110–0.119] | +1.1% |
| embeddings-1x1024-21741B | 0.205 [0.198–0.229] | 0.206 [0.201–0.220] | +0.7% |
| embeddings-1x3072-65999B | 0.406 [0.396–0.414] | 0.404 [0.392–0.410] | -0.3% |
| embeddings-16x3072-1056375B | 4.795 [4.755–4.815] | 4.879 [4.706–4.937] | +1.8% |
| embeddings-64x3072-4225940B | 20.808 [20.308–21.408] | 20.559 [20.197–21.199] | -1.2% |
| decision-median-59answers-3773B | 0.253 [0.246–0.324] | 0.255 [0.248–0.327] | +0.5% |
| decision-max-61answers-3898B | 0.259 [0.245–0.267] | 0.255 [0.251–0.258] | -1.8% |
| embeddings-64x3072-4225940B; eight concurrent requests | 155.047 [151.927–159.090] | 168.315 [161.572–174.068] | +8.6% |
| catalog-33models-1259B-delay20ms | 21.396 [21.094–21.810] | 21.447 [20.910–21.901] | +0.2% |

Positive change means slower. The eight-request row reports elapsed time per **batch of eight**, not per request. The 20 ms delay is a synthetic sensitivity check, not measured provider latency.

Single-request ranges overlap. At concurrency eight, the default-sink range is entirely above the baseline range. The earlier `asUint8Array: true` prototype also regressed that case (154.619 → 165.433 ms, +7.0%), so the typed-array view adjustment did not create the conclusion.

## Reader only

| Production-derived payload | Current, ms | Default sink, ms | Change in median |
| --- | ---: | ---: | ---: |
| catalog-37models | 0.0047 [0.0047–0.0050] | 0.0053 [0.0053–0.0058] | +11.6% |
| catalog-33models | 0.0051 [0.0050–0.0054] | 0.0056 [0.0056–0.0060] | +11.0% |
| catalog-13models | 0.0046 [0.0046–0.0048] | 0.0053 [0.0052–0.0054] | +15.4% |
| embeddings-1x1024 | 0.0102 [0.0098–0.0116] | 0.0107 [0.0099–0.0123] | +4.3% |
| embeddings-1x3072 | 0.0204 [0.0201–0.0207] | 0.0225 [0.0219–0.0241] | +10.0% |
| embeddings-16x3072 | 0.2543 [0.2518–0.2593] | 0.3510 [0.3404–0.3551] | +38.0% |
| embeddings-64x3072 | 1.2305 [1.2101–1.2683] | 1.9591 [1.9340–2.1246] | +59.2% |
| decision-median-59answers | 0.0055 [0.0054–0.0056] | 0.0066 [0.0063–0.0066] | +20.2% |
| decision-max-61answers | 0.0056 [0.0054–0.0060] | 0.0065 [0.0064–0.0068] | +16.0% |

The 64 × 3,072 payload is 4,225,940 bytes. The default sink increases reader time from 1.230 to 1.959 ms (+59.2%). Moving the byte copy into native code does not eliminate it.

## Sizing the sink

| Scenario | Current | Default sink | 64 KiB initial capacity | Full-cap initial capacity |
| --- | ---: | ---: | ---: | ---: |
| reader: embeddings-16x3072 | 0.254 ms | 0.351 ms | 0.343 ms | 0.274 ms |
| reader: embeddings-64x3072 | 1.231 ms | 1.959 ms | 1.953 ms | 1.500 ms |
| actual-client+http: embeddings-64x3072-4225940B-c1 | 20.808 ms | 20.559 ms | 20.574 ms | 20.090 ms |
| actual-client+http: embeddings-64x3072-4225940B-c8 | 155.047 ms | 168.315 ms | 164.655 ms | 161.781 ms |

Full-cap sizing helps the sink on large payloads but remains slower than the current reader on these production-vector batches, and slower under concurrency. Its single-request full-client advantage is within overlapping ranges. No peak-memory or allocation-count claim was measured.

## CPU profiles

Separate profiling processes exercised the 16 × 3,072-vector actual embedding client repeatedly for three seconds. Profiles also include setup and preflight checks; percentages are process samples, not exact request-phase attribution.

- Current: JSON parsing 53.8% self time, TypeBox array validation 9.4%, UTF-8 decoding 6.3%, `joinBytes` 1.8% self / 2.4% inclusive; native `set` 2.8%.
- Sink: JSON parsing 52.2%, TypeBox array validation 8.5%, UTF-8 decoding 6.1%, sink `write` 6.2%, sink `end` 1.2%.

Parsing is the main CPU limiter. The entire baseline reader takes about 0.254 ms of the 4.795 ms local embedding-client request: even making that entire phase free has a roughly 5.3% latency-saving ceiling in this scenario. The sink replaces copying with other copying and does not approach that ceiling. No remote-provider or whole-application speedup is claimed.

Local profiles: `/tmp/ditzy-sink-profile.jnJCdr/production-baseline.cpuprofile` and `production-candidate.cpuprofile` (Markdown format from `--cpu-prof-md`).

## LOC and behavior

| File: model-fetch.ts | Physical lines | Nonblank lines |
| --- | ---: | ---: |
| Current | 96 | 92 |
| Screenshot-style sink, typed-array output | 85 | 82 |
| Type-correct minimal sink, ArrayBuffer output + view | 84 | 81 |
| Potential application reduction | **12** | **11** |

**Removed:** the chunk array and the 11-line `joinBytes` function, plus its separating blank line. **Introduced:** one native sink, one bounded write per chunk, and output views at the existing return sites. **Behavior changed:** none intended; the response caps, prefix truncation, early cancel, abort handling, and reader cleanup remain in the prototype.

The savings are small and the response loop remains necessary. This work leaves production source untouched. The research harness and this report are measurement artifacts, excluded from the application LOC comparison.

Validation:

- Existing model-fetch tests against both baseline and final prototype: **6 passed, 0 failed** (the same three tests per implementation).
- Final candidate reader passes TypeScript 7 with the installed Bun declarations and strict settings.
- Harness preflight: **48 checks** across four implementations, covering null/empty bodies, zero/exact/overflow caps, fragmented prefixes, cancellation including rejected cancel promises, already-aborted signals, caller abort through `fetchWithTimeout`, stream failure, and released reader locks.
- Final production-data benchmark: **3,250,073 completed operations**, **108,523 local server requests**, **0 failures**; output counts/sentinels checked during timing and entire client outputs checked beforehand.

A pre-existing direct-reader race also reproduced identically: aborting while `reader.read()` is pending can let stream cancellation win the Promise.race and return an empty result. All current callers use `fetchWithTimeout`, whose outer abort race rejects as tested. This profiling task did not change that behavior.

## Reproduce

Run from this checkout with dependencies installed:

```sh
bun docs/research/bun-arraybuffer-sink-profile.mjs
```

It prints a private temporary output directory containing the DB snapshot, both reader prototypes, bundled clients, and `production-results.json`. The DB and all generated payloads remain outside the repository. Override the input path with `PROFILE_DB=/path/to/sample.sqlite`.

For separate CPU profiles (do not run concurrently with timings):

```sh
PROFILE_SIDE=baseline bun --cpu-prof-md --cpu-prof-name=baseline.cpuprofile docs/research/bun-arraybuffer-sink-profile.mjs
PROFILE_SIDE=candidate bun --cpu-prof-md --cpu-prof-name=candidate.cpuprofile docs/research/bun-arraybuffer-sink-profile.mjs
```

Local prototype patch and original run artifacts: `/tmp/ditzy-sink-profile.jnJCdr/`. The source proposal was not applied.
