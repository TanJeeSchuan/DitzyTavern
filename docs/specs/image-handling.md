# Image handling: Portraits and Images in writing

## Problem Statement

DitzyTavern is text-only. Characters and Participants are shown with names and initials only, so a Cast of similar names is hard to scan and imported character artwork is thrown away. Writers also cannot show a model what a scene, outfit, map, screenshot, or document page looks like. They have to describe it in prose, which loses detail and still costs tokens.

Version one excluded images because each use needs storage, provider, rendering, and security work. Two separate design sessions have now settled that work: one for Portraits (artwork that represents a Definition) and one for Images inside writing that the model receives. The two share one store and one ingest rule, so they are specified and built together.

## Solution

Add one content-addressed Image store in SQLite. An Image is a picture stored once by the SHA-256 of its metadata-stripped bytes. Portraits and Image References name Images, and an Image is deleted in the same transaction that drops its last reference.

Give every Definition an optional Portrait with a focal point. Show it wherever identity is rendered, with initials when there is none.

Let writers place Images inline as `![name](image:<sha256>)` in Messages, Definitions, Openings, and Macro Variable values, through one CodeMirror 6 editor that draws each Reference as an atomic chip. At Generation time, References become native image parts at their inline positions, preceded by an `[Image: name]` anchor. Every text-only consumer reads only the anchor.

Writers decide which copy of a repeated Image is sent. They can mark a model as a Text-only Model after a failed Generation. They can always inspect the Images that a Prompt Plan will send.

## User Stories

### Images and ingest

1. As a writer, I want the same picture used in many places to be stored once, so that reusing artwork or a map across Chats costs no extra space.
2. As a writer, I want GPS coordinates, camera data, and other embedded metadata removed from every picture I add, so that I never send my location to a provider.
3. As a writer, I want pictures kept at their original resolution and quality, so that screenshots and document pages stay readable.
4. As a writer, I want animated GIFs to keep their animation, so that animated Portraits and references still move.
5. As a writer, I want PNG, JPEG, WebP, and GIF accepted up to 20 MB and anything else rejected with a clear reason, so that I know what can be added.
6. As a writer, I want a picture removed once nothing uses it, so that the database does not grow with abandoned artwork.
7. As a writer, I want a picture that is still used anywhere to be kept, including by an older story branch's Macro State, so that switching branches never shows a broken Image.

### Portraits

8. As a writer, I want to give a Character a Portrait, so that I can recognize it in the library at a glance.
9. As a writer, I want to choose a focal point, so that the important part of the artwork stays visible in round, square, and wide frames.
10. As a writer, I want a Participant seeded from a Character to copy its Portrait, so that a new Chat starts with the right artwork.
11. As a writer, I want changing a Character's Portrait to leave existing Chats unchanged, so that Chat-local identities stay independent.
12. As a writer, I want Save as Character to carry a Participant's Portrait back, so that artwork chosen in a Chat can be reused.
13. As a writer, I want ad-hoc Participants to have Portraits too, so that every Cast member can be recognized.
14. As a writer, I want Messages to show their Participant's current Portrait, so that changing a Participant's artwork updates the whole Chat.
15. As a writer, I want a removed Participant's Messages to fall back to the stamped name's initial, so that history stays readable after removal.
16. As a writer, I want initials shown where a Definition has no Portrait, so that every identity still has a mark.
17. As a writer, I want a Portrait never to be sent to the model on its own, so that artwork does not silently add cost to every Generation.
18. As a writer, I want to insert a Definition's Portrait into its Identity text as an Image Reference, so that I can deliberately show the model what a character looks like.

### Writing with Images

19. As a writer, I want to paste, drop, or pick an Image into the composer at the cursor, so that the Image sits exactly where it matters in my Message.
20. As a writer, I want each Image Reference shown as a chip with a thumbnail that the cursor and backspace treat as one unit, so that I never break a Reference by editing around it.
21. As a writer, I want the text I type saved exactly as typed, so that `*actions*`, quotes, macros, and whitespace are never rewritten by the editor.
22. As a writer, I want to add Images when editing a Variant, so that I can add or remove a picture after sending.
23. As a writer, I want to place Images in a Definition's Prompt channels, so that a character reference sheet or setting map is part of its Definition.
24. As a writer, I want to place Images in Openings, so that a greeting can open with a scene image.
25. As a writer, I want Macro Variables to hold Image References, so that `{{getvar::outfit}}` can show a different outfit on each story branch.
26. As a writer, I want to copy a chip and paste it into another Chat or Definition, so that I can reuse an Image without uploading it again.
27. As a writer, I want Images in the story shown as inline thumbnails that open full size, so that I can read the story without large pictures pushing prose apart.
28. As a writer, I want a Reference whose Image is gone shown as its muted `[Image: name]` anchor, so that a missing picture is visible but does not break the Message.
29. As a writer, I want Image names cleaned so that they cannot break the Reference syntax, so that any file name is safe.
30. As a writer, I want remote image links written by a model or pasted in never to load, so that no outside server learns when I read a story.

### Generation with Images

31. As a writer, I want the model to receive each Image at its position in my writing, with its name just before it, so that it can refer to "the map" in context.
32. As a writer, I want Images in Definition slots sent as system or assistant to still reach the model, so that a slot's role does not silently drop artwork.
33. As a writer, I want a Message I wrote with Images to keep them after Control seats move, so that changing who writes does not lose pictures from history.
34. As a writer, I want a continuation by assistant prefill refused with a clear reason when the continued text contains an Image, so that the request is never sent in an order the provider rejects.
35. As a writer, I want to choose whether a repeated Image is sent at its first occurrence, last occurrence, or every occurrence, with the trade-offs explained, so that I can weigh focus against prompt caching and cost.
36. As a writer, I want the default to send the last occurrence, so that re-showing a picture makes the model look at it now.
37. As a writer, I want Token estimates to count Images conservatively, so that a request with Images does not overflow the context limit.
38. As a writer, I want whole history entries containing Images kept or evicted together, so that an Image never appears without its surrounding text.
39. As a writer, I want Prompt inspection to show the Images a Generation will send, so that I can check what the model will see before sending.
40. As a writer, I want to add or remove Images while editing an inspected Prompt Plan, so that one-shot edits work the same with pictures.
41. As a writer, I want Lore matching, Memory extraction, and Token estimates to read Images as their `[Image: name]` anchor, so that hashes never pollute matching, Memories, or counts.
42. As a writer, I want no model ever to see an Image's hash as text, so that a model cannot copy a Reference into its output.
43. As a writer, I want a Generation whose Image is missing to send the anchor and warn me in inspection and Generation Details, so that one lost picture does not block the Chat.

### Text-only Models

44. As a writer, I want a failed Generation that contained Images to show the provider's error and offer to mark the model as text-only, so that I can judge the error myself and recover in one step.
45. As a writer, I want to mark the model and retry in one action, so that I can keep writing immediately.
46. As a writer, I want the text-only mark stored per model on its Connection Profile, so that every Chat using that model benefits and switching models changes behavior automatically.
47. As a writer, I want the mark visible and reversible in the model picker, so that a mistaken mark is easy to undo.
48. As a writer, I want a Text-only Model to receive the `[Image: name]` anchors, so that it still knows a picture was there.

## Implementation Decisions

1. **One Image store.** Add an `image` table keyed by SHA-256 with the stored bytes, media type, byte size, and dimensions. It is the single store for Portraits and prompt Images. Images are immutable and served by hash with permanent caching. The Exact Source Artifact module is unchanged and unrelated.
2. **One ingest rule.** The server identifies PNG, JPEG, WebP, and GIF by magic bytes and rejects anything else or anything over 20 MB with a typed error. It strips metadata losslessly with `@uwx/exif-be-gone-web` before hashing, keeping ICC profiles, pixel data, and GIF animation. It reads dimensions from the container header. It never resizes, transcodes, or decodes. The client sends original bytes.
3. **Transactional lifetime.** A reference index records which owners reference which Images: Variants, Character and Participant Prompt channels, Openings, Definition Portraits, Macro State values, and Active Generation records. Every write of an owner's text re-syncs its rows, owner deletes cascade into the index, and an index trigger deletes an Image with no remaining references. GC runs in the same transaction as the change that dropped the reference. There is no sweep, grace period, or standalone upload endpoint.
4. **Bytes travel with the first reference.** Commands that can introduce a Reference or Portrait carry the new Images' bytes inline: Send, Variant edit, Character and Participant Definition create and update (including Openings), Macro Variable apply, and generation from an edited inspected plan. The server ingests them inside the command's transaction. A command whose text references a hash that is neither in the store nor in its payload stores the text as written; rendering and Generation treat that Reference as missing.
5. **Portrait shape.** A Definition holds an optional Portrait: an Image hash and a focal point. It copies with the Definition on seeding, Save as Character, and duplication. Author Stamps do not capture Portraits. A Participant Tombstone loses its Portrait with its Definition. Display applies the focal point as the CSS object position on full-resolution artwork. A Portrait never enters a Prompt Plan.
6. **Reference syntax.** References are `![name](image:<sha256>)`. One shared parser finds them. Names are sanitized on insert: brackets, backslashes, and line breaks become spaces, whitespace collapses, length is bounded, and a name is never empty. Prose rendering resolves only the `image:` scheme. Any other image URL, including remote ones written by a model, is never fetched.
7. **One editor.** A shared CodeMirror 6 `ProseEditor` replaces the textareas in the Composer, Variant edit, Definition editor (Prompt channels and Openings), and Macro Variables panel, and is used read-write in Prompt inspection. The document is the stored text. `Decoration.replace` widgets draw References as thumbnail chips, and `atomicRanges` makes them single cursor units. Paste, drop, and a file picker insert References at the cursor. The Definition editor offers Insert Portrait. Prompt Preset and Lore Entry editors do not offer Image insertion.
8. **Image Anchor projection.** One function renders each Reference as `[Image: name]`. The Lore Scan Window, Semantic Trigger judging, Memory extraction, embeddings, and the Estimation transcript read text only through it.
9. **Resolution after expansion.** Reference resolution runs after Prompt Macro expansion over the whole Prompt Plan, so Macro output can produce References. Prompt Plans, Generation checkpoints, Active Generation records, and inspection hold References, never bytes.
10. **Repeated Image Placement.** A Generation Setting with the values first, last (default), and every decides which occurrences of an Image send it, computed after budget eviction. Other occurrences send only their anchor. The settings UI explains the trade-offs: first keeps the prefix stable for prompt caching, last focuses the model on the most recent showing but invalidates the cached prefix from the earlier position, and every pays full cost for each copy.
11. **Estimate and eviction.** Each sent Image costs `w·h/750` estimated tokens after notionally fitting its long edge to 1568 px, the same for every Format. The cost is added to the entry holding the Image. Eviction still removes whole entries.
12. **Wire translation.** The Model Client loads bytes from the store while building the request. For each Reference, it emits the anchor text and then an AI SDK image part at the Reference's position. Image parts only go in `user` messages. Images inside `system` or `assistant` messages are placed in a `user` message immediately after that message. An assistant prefill whose text contains an Image is refused with a typed reason before any request. Request Overrides still cannot supply image, file, modality, audio, or tool fields.
13. **Text-only Model.** A Connection Profile stores a set of model IDs marked text-only, beside the Discovery Catalog. Generations for those models send anchors without Images. The mark is never inferred. When a Generation fails before output and its plan sent Images, the failure view shows the provider message with Mark text-only and Mark text-only and retry actions. The model picker shows and toggles the mark.
14. **Missing Images.** A Reference whose hash is not in the store renders as a muted anchor, sends its anchor only, and adds a warning to Prompt inspection and Generation Details.
15. **Design language.** Portrait frames, chips, inline thumbnails, the full-size Dialog, and the missing-anchor style follow DESIGN.md, using Radix and shadcn components. DESIGN.md is amended where it lacks guidance for chips and inline Images.
16. **Database workflow.** Schema changes follow the SQLite and Drizzle workflow. Clearing tables is acceptable in this dev environment. Seed data that includes Images gets a matching teardown that imports the same data.

## Testing Decisions

1. Test observable behavior: stored and served bytes, captured outgoing provider requests, command outcomes, and saved state. Do not assert file layout, helper call order, or other architecture. No tautological tests.
2. Ingest: prove a JPEG with GPS EXIF, a PNG with `tEXt` card data, and a WebP with XMP come back without metadata and with identical pixel data, that an animated GIF keeps its frames, that the same upload twice yields one Image, and that unsupported types and oversized files are rejected without mutating state.
3. Lifetime: through public commands, prove that an Image survives while any owner kind references it (including a Macro State value on a non-selected branch), is gone after the last reference is removed by edit, delete, or cascade, and that a failed command leaves neither the Image nor the reference.
4. Generation: use the existing captured-request pattern to prove anchor-then-image placement, `system` and `assistant` placement into the following `user` message, the seat-swap case, prefill refusal, each Repeated Image Placement value after eviction, Text-only Model anchors, missing-Image anchors with warnings, macro-produced References, and that no hash appears in any outgoing text.
5. Estimates: prove the per-Image cost formula and whole-entry eviction through the existing budget interface.
6. Text consumers: prove the Lore Scan Window, Memory extraction input, and Estimation transcript contain anchors and no hashes.
7. Portraits: prove copy on seeding, independence after Character edits, Save as Character, tombstone fallback, and Portrait absence from Prompt Plans through the existing Character Library and Conversation contracts.
8. No UI tests. Verify the editor, chips, thumbnails, Dialog, Portrait frames, focal point, and Text-only Model flow manually in the browser with playwright-cli.

## Out of Scope

- Tavern Card and SillyTavern chat image import, and URL image sources.
- References in Prompt Preset and Lore Entry text, and Lorebook or Preset export with Image bytes.
- Image generation, audio input and output, file attachments other than Images, and tool calls.
- Describe-once captioning and any automatic text description of Images.
- Inferring image support from Discovery Catalogs or provider errors.
- Server-side resizing, transcoding, or thumbnail generation.
- Character-derived ambient color.
- OpenAI Responses and Anthropic Messages image shaping, which remain deferred with those Formats.

## Further Notes

ADR-0045 records Portraits as content-addressed Definition Images. ADR-0046 records native Images in writing, the shared store, the ingest rule, the editor choice, and the trade-offs of Repeated Image Placement. ADR-0001 and ADR-0015 are superseded in part. Image, Image Reference, Image Anchor, Text-only Model, Repeated Image Placement, and Portrait are defined in CONTEXT.md.

T3 Code (pingdotgg/t3code at ce90eec1) was used as reference for Markdown-link References and label sanitization. Its Tiptap composer was rejected because its Markdown round trip normalizes text.
