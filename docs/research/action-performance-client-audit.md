# Client user-action performance audit

Scope: client rendering, fetching/invalidation, streaming, navigation, editors, library, and image flows. This is source analysis, not a benchmark; no speedups are estimated. The findings describe structural work and the user actions that trigger it. Server generation, database, and Boxes are outside scope.

## Findings

### 1. A story update revisits every loaded message

`StoryStage` maps the full `story.messages` array to `StoryMessageView` instances ([StoryStage.tsx:171](/home/tan/Projects/DitzyTavern/src/client/workspace/StoryStage.tsx:171)); the component is not memoized ([StoryMessageView.tsx:41](/home/tan/Projects/DitzyTavern/src/client/story/StoryMessageView.tsx:41)). During an active generation, stream events update story state, so React reconciles the loaded list for each such update. Each row also performs variant lookup and effects, and derives `activeGeneration` by scanning targets in the parent ([StoryStage.tsx:180](/home/tan/Projects/DitzyTavern/src/client/workspace/StoryStage.tsx:180)). Cost scales with messages currently loaded and update frequency; long histories plus frequent stream updates are the precondition.

Small fix: memoize `StoryMessageView` and pass stable row props; compute a `Set` of active message/variant target keys once in `StoryStage`, replacing repeated target-array scans. Keep the memo boundary invalidated by the changed row, lens, and callbacks. This does not reduce the required story-state update itself.

### 2. Prose rendering reparses the accumulated stream on every text change

`Prose` calls `revealedLength(text)` while streaming, which parses the entire accumulated Markdown to locate its final block ([prose.tsx:125](/home/tan/Projects/DitzyTavern/src/client/story/prose.tsx:125)). It then slices the revealed prefix and memoizes `renderBlocks(shown)` against that prefix ([prose.tsx:189](/home/tan/Projects/DitzyTavern/src/client/story/prose.tsx:189)). A delta need not change the revealed prefix: sentence/chunk gating already avoids some rendering calls. The reveal calculation still parses the full raw text on each render, and a changed prefix causes another parse. Long streamed variants make this repeated work grow with accumulated text and update count. Memoized `ProseBlock` already avoids rewriting unchanged HTML blocks ([prose.tsx:162](/home/tan/Projects/DitzyTavern/src/client/story/prose.tsx:162)).

Small fix: retain completed rendered blocks and reparse only the unfinished tail, with invalidation when an edit or variant replacement changes earlier text. A simpler lower-risk first step is to batch stream-driven UI publication to animation frames; that lowers parse invocation count at the cost of slightly coarser visible updates.

### 3. Nearby swipe text is fetched eagerly for the latest message

For the latest message, `StoryMessageView` prefetches both adjacent missing variant texts in an effect ([StoryMessageView.tsx:162](/home/tan/Projects/DitzyTavern/src/client/story/StoryMessageView.tsx:162)); touch start also does this regardless of whether the gesture becomes a swipe ([StoryMessageView.tsx:183](/home/tan/Projects/DitzyTavern/src/client/story/StoryMessageView.tsx:183)). Each missing text is a separate query/request ([variant-text.ts:33](/home/tan/Projects/DitzyTavern/src/client/story/variant-text.ts:33)). This avoids delay when switching, but incurs up to two extra text fetches for a latest message whose neighboring swipes are not viewed. Large histories do not multiply this: it is limited to the latest/selected message and its two neighbors.

Small fix: prefetch only the direction the user indicates (hover/focus, keyboard navigation, or a swipe gesture crossing a direction threshold), or defer until the Swipe browser opens. Tradeoff: the first switch can wait on the request.

### 4. Character library list reloads on each Cast panel mount

`CharactersPanel` calls `listCharacters()` from a mount effect ([CharactersPanel.tsx:48](/home/tan/Projects/DitzyTavern/src/client/characters/CharactersPanel.tsx:48)); the call is a direct uncached request ([character-library.ts:41](/home/tan/Projects/DitzyTavern/src/client/character-library.ts:41)). Opening and closing the panel therefore repeats the library-list fetch, even when the collection has not changed. This applies to each panel opening; it is not evidence that list size makes the request slow.

Small fix: put the list behind a TanStack Query key and invalidate/update it after create, save-as, edit, pin, and delete. Existing React Query cache lifetime can then serve repeated opens; mutation paths must keep it fresh.

### 5. Image uploads base64-expand file bytes before sending

The shared `uploadImage` reads each file as a data URL and extracts its base64 body ([image.ts:4](/home/tan/Projects/DitzyTavern/src/client/lib/image.ts:4)), then posts the encoded string ([image.ts:11](/home/tan/Projects/DitzyTavern/src/client/lib/image.ts:11)). Base64 expands payload size and creates a JavaScript string copy before the request. This cost occurs for composer/editor image insertion and Chat-background selection; it is most relevant for large files and multiple images. The UI allows background files up to 20 MB ([ChatBackground.tsx:61](/home/tan/Projects/DitzyTavern/src/client/ChatBackground.tsx:61)).

Small fix: use the existing image endpoint with a binary `Blob`/`File` request body and the appropriate media type, removing the FileReader data-URL conversion and base64 string. This requires the route/client contract to accept raw bytes; it is a protocol change, not a client-only substitution.

### 6. Editor image chips rebuild from a full-document parse after every edit

The CodeMirror chip plugin calls `chips(view)` whenever `docChanged` is true ([ProseEditor.tsx:58](/home/tan/Projects/DitzyTavern/src/client/editor/ProseEditor.tsx:58)); `chips` converts the whole document to a string and parses every image reference ([ProseEditor.tsx:45](/home/tan/Projects/DitzyTavern/src/client/editor/ProseEditor.tsx:45)). Typing in a document containing references therefore reparses all references on every keystroke. This is bounded by editor document size and is most relevant for long image-heavy messages or definitions.

Small fix: update decorations only in the changed ranges and map unaffected ranges through the CodeMirror transaction; reparse newly inserted/replaced ranges and references intersecting changed boundaries. This removes repeated whole-document scans while preserving atomic chip behavior.

## Ambitious ideas

1. **Virtualize history pages.** Introduce a virtual story viewport that mounts only visible messages plus a small overscan window, keeping the existing scroll-anchor and message-position semantics. It would bound React work, DOM size, layout, and memory as users browse long histories. Tradeoffs: dynamic prose height and streaming complicate measurements; focus/selection, accessibility reading order, swipe dialogs, image layout shifts, and prepend/append anchoring need careful handling. This is a larger behavior-preserving rewrite and should be evaluated against the current page-based history model.

2. **Incremental streaming presentation pipeline.** Introduce a per-variant stream accumulator that batches deltas and incrementally emits complete prose blocks, replacing repeated whole-prefix `renderBlocks` calls and per-delta stage publication. Remove the current full-prefix render path and any redundant per-event state publications once the accumulator owns them. Tradeoffs: formatter state must handle syntax spanning chunk boundaries, reconnect/replayed events, edits and swipe replacement; batching adds bounded display latency and increases state-machine complexity. It could jointly reduce React update frequency and text reparsing, but is materially more complex than frame batching.

## Limits

These are source-derived cost centers, not measured user-visible regressions. No tests, profilers, or servers were run. Prioritize by real usage: large loaded stories and long streamed prose for findings 1–2; swipe-heavy interactions for 3; repeated panel opening for 4; large image uploads for 5; long image-rich edits for 6.
