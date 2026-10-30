# Collapsing the request-shaping problem space (2026-10-30, revised)

Follow-up to [client-request-shaping.md](client-request-shaping.md). The first version of this document proposed one primitive, the Fact (`aggregate:id@revision`), as the concurrency guard, the read validator and the replica position all at once. A GPT 6.0 Astra (high) review against the code showed that this equivalence is false here. This version keeps the collapse and drops the equivalence.

## Why a write revision is not a read version

Each of the following is verified in the code:

- **Revision-neutral writes:**
  - preset recipe edits (`withRecipe`, `src/server/prompt-preset/blocks.ts:173`, and the Box-block install at `:227`);
  - model-discovery catalog replacement (`src/server/connection-settings/index.ts:297`);
  - Box digest records and catch-up (`src/server/box/records.ts:70`, `digest.ts:265`);
  - generation checkpoints (`active-generation.ts:369`, by design, ADR 0031).
- **Creation and deletion have no revision to advance:** native create and import (`conversation/create.ts:303`, `workflows/imported-conversation.ts:30`); Character, Lorebook and preset deletes (`character-library/execute.ts:55`, `lorebook/library.ts:311`, `prompt-preset/library.ts:245`).
- **Cascades and reassignment change other rows silently.** Lorebook delete cascades into attachments; preset delete reassigns conversations to Default without bumping them; profile delete nulls model selections through a foreign key (`schema.ts:208/223/238/845`, `prompt-preset/library.ts:257`).
- **Projections read across aggregates.** The conversation summary embeds the live source-Character name (`conversation/internal.ts:106`) and the fork-source name (`snapshot.ts:293`). The preset summary carries a conversation count (`prompt-preset/library.ts:93`). Macro variables read the preset name (`macro-variables.ts:97`). Digest, Memory and Race windows each read four or more sources.
- **`ConversationWriteChange` is a digest-work hint, not a change log.** It fires only when a handler reports (`transaction.ts:85`). Selecting a variant reports only the new id, not the sibling it deselected (`select-variant.ts:19`). Macro edits report nothing (`macro-variables.ts:151`).
- **Text is mutated in place:** variant edits, provisional resolution, record slots (`edit-variant.ts:28`, `active-generation.ts:261`, `records.ts:80`).

So any design that publishes from an inventory of write sites, or validates reads with an aggregate revision, is wrong today and wrong again after the next feature adds a write path.

## The collapse that survives: coverage by construction

Three mechanisms, each correct regardless of which code path wrote, or what a projection reads.

### 1. Change detection at the database, not at the writers

The server has one production SQLite connection (`src/server/database/database.ts:38`). SQLite tracks every committed change for us:

- `SELECT total_changes()` counts rows changed on this connection, including foreign-key cascades.
- `PRAGMA data_version` changes when *another* connection commits. That covers a Box plugin that opens its own handle; `box/registry.test.ts:276` shows a Box can.

Measured in Bun 1.4.4: a check costs **0.21 µs**. Cascades count: deleting a parent with two children added 3. No-op updates and rolled-back transactions also increment it. Those are false positives, and they are harmless: they cause a refetch that comes back 304.

A server ticker (~100 ms) compares both values. When either moved, it bumps `seq` and emits `{epoch, seq}` on `/api/changes`. Polling moves from the network (1.48 MB every 2.5 s) to an integer comparison in-process. No writer changes, no inventory to keep current, and a new write path is covered the day it lands.

Optional scope hints narrow the client's refetch: `runConversationTransaction` and the other transaction helpers can add `conversationId` to the next emission. A missing hint means "refetch all active reads", which is never wrong.

### 2. Validation by content, not by revision

Every JSON `GET /api/*` gets `ETag: W/"<Bun.hash(body)>"` and `Cache-Control: no-cache`, in one `onAfterHandle`, excluding `text/event-stream`. A matching `If-None-Match` returns 304.

- **Correct by construction.** The validator is the bytes, so cross-aggregate projections, live checkpoints and revision-neutral writes cannot produce a stale 304.
- **No client changes.** The browser's HTTP cache revalidates `fetch()` GETs and hands Eden the cached body on 304, so the `request-outcome.ts:85` "expects a decoded body" concern does not arise.
- **Cheap.** `Bun.hash` over 1.5 MB measured **0.11 ms**.
- **Through Cloudflare.** It downgrades strong ETags when it compresses, so emit and compare weak validators.

The server still computes the projection before it can hash it. With item 1 in place, that happens only after a change, not every 2.5 s.

This stage is useful alone. Today's digest polling drops from 1.48 MB to a ~200-byte 304 per tick, before any Feed exists.

### 3. The Feed triggers reads; React Query stays the cache

The client keeps TanStack Query as the materialised read cache. Building a replica is not justified: `generation-sessions.ts` owns transport cursors, and `story.ts` owns Requested, Preview and streaming reconciliation (`story.ts:314/342/362`). Neither is a duplicate copy.

On `{epoch, seq, scope?}` the client calls `invalidateQueries` on the active queries in scope. Query already allows one in-flight request per key and dedupes it, which covers coalescing on the client. With item 2, an unchanged read costs a 304.

Rules from the review that the design must keep:

- **Epoch.** The server process start id. A client seeing a new epoch, or a gap it can't trust, refetches all active reads. That is the ADR 0004 "fresh snapshot" fallback, and it needs no replay buffer at all, because the Feed carries no data.
- **Subscribe-then-read on boot and reconnect.** Open the Feed first, then let queries run. A change between the two is caught by the seq that arrives after the read.
- **Heartbeat.** `/api/updates/events` already sends one every 5 s (`contract/updates.ts:12`); reuse that.
- **Bounded server queue.** `subscriptionEvents` buffers without a limit (`subscription-events.ts:8`). For the Feed, keep only the latest `{epoch, seq}` per subscriber. A slow client receives one coalesced event, not a backlog.
- **Generation output stays separate.** It has its own ordering and replay (ADR 0031), and a checkpoint commit will tick the Feed. Exclude live generations from scope-hinted history refetch while their SSE is open, or the Feed re-downloads every checkpoint.
- **Box reads stay Box-shaped.** `useBoxRead` decodes against the Box schema and instance (`box-windows/useBoxRead.ts:15`, README §instances). The Feed only tells the host to invalidate. It never calls Box code, so a hung or thrown Box cannot stall other subscribers.
- **Commands keep their meaning.** Write revisions remain concurrency guards. The per-tab command queue still drops dependent commands after a conflict (`conversation-command-runner.ts:66/130`), and draft editors still keep unsaved input on 409.

What this removes: every `refetchInterval` (PassageTimeline, `useBoxStatus`, Memory).

Found during implementation: revalidating *every* open read on each change breaks lost-update protection. Many commands read their expected revision from the live cache when they are submitted. If that cache refreshes underneath an open confirmation or draft, the command applies over a change the user never saw. In e2e, a Box removal confirmed before another tab saved its setup deleted that setup, and a Race stats sheet overwrote stats saved in another Chat. So reads opt in (`followsChanges`) and only the ones that used to poll do. Conversation reads keep the focus refetch and conflict recovery. Making them live as well needs each confirmation and draft to pin the revision it was opened at.

## Bytes: narrow the payloads, skip the blob store

Stage 3 of the first version, the content-addressed text store, is dropped for now. Hashing a mutable row does not make it immutable (`edit-variant.ts:28`), so a real version needs immutable blob rows, reference swapping and garbage collection. The measured waste can be removed more simply:

- History: return selected-variant content only, plus ids for the others. Fetch a variant on browse and prefetch its neighbours. Load reasoning when the collapsible opens. On the measured chat, page 1 goes from 506 KB to about 80 KB.
- Digest timeline: drop passage `content`; the client already holds history. Keep Box-owned display projections, which deliberately withhold hidden state (`boxes/race/server.ts:30`).
- Memory: stop reading every variant's prose just to check freshness (`boxes/memory/server-memories.ts:18`), and reuse the author read (`server-chat.ts:32`).

Revisit content addressing only if reload and fork transfer show up in measurements after these.

## Independent point fixes (no architecture needed)

These do not depend on anything above and should go first:

1. **Send latency.** `finishStart` waits for `refreshStory` before subscribing (`useAssemblyController.ts:154`). `story.ts:315` already buffers early observations, so subscribe immediately and refresh concurrently.
2. **Boot.** Start `/api/workspace` beside `loadBoxClients()` (`main.tsx:32`). Have `serveIndex` emit `<link rel=preload as=fetch>` for a fixed boot read set. Load Box CSS in parallel with its JS.
3. **Shared queries.** Characters (`CharactersPanel.tsx:48`, `NewChatPanel.tsx:183`) and Lore attachments (`LoreAttachmentEditor.tsx:28`) use local state, so they need migrating onto one shared query each, not just a key rename. The preset recipe is under three keys. Query signals also cancel obsolete reads, which these components don't do today.
4. **Chat-list rows carry `revision`.** This removes rename's pre-read (`workspace.ts:63`).
5. **Box module versioning.** Versioned URLs must resolve to the named bytes, not to the current file under an old hash. The CSS is `./client.css`, relative to the JS (`build-box-client.ts:10`). Until a real versioned file set exists, the content ETag from item 2 covers this: a 304 per module instead of 205 KB.
6. **Prompt preview stays out of prefetch.** One preview token per conversation; a second tab replaces the first (`workflows/generation-preview.ts:151`).

## Staging

| Stage | Introduces | Removes | Depends on |
|---|---|---|---|
| 0. Point fixes 1–6 | — | Send waterfall, boot waterfall, duplicate fetches, rename pre-read | nothing |
| 1. Content ETags | one `onAfterHandle` | ~all repeated API bytes (polls become 304s) | nothing |
| 2. Change ticker + `/api/changes` | `total_changes`/`data_version` ticker, epoch, latest-only subscriber slot, client invalidation hook | all polling, focus refetch, Chats refetch; stale tabs | 1 makes its refetches cheap |
| 3. Payload narrowing | selected-only history, lazy reasoning, content-free digest | ~85% of history and digest bytes | nothing; better after 2 |

Dropped from the first version: the universal Fact, revision ETags, the replica store, the text blob store, and `need(view)`. Boot preload uses a fixed read set, because plugin routes make a host-side `need(view)` incomplete (`docs/box-system/README.md:211`).
