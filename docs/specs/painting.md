# Painting: Appearance, the Paint panel and Illustrations

## Problem Statement

A writer cannot get a picture of a moment in their story. They can add pictures they made elsewhere, but nothing in the app makes one, and nothing records how a character looks beyond the Portrait and whatever the writer typed into Identity.

Getting consistent pictures of a character needs three things the app lacks: a place that says and shows how the character looks, a way to turn a moment in the Chat into a request an image model understands, and a place for the result that does not add cost to every later Generation.

## Solution

Give every Definition an Appearance: description text with pictures in it, with a switch deciding whether models receive the pictures or only their names. A model can describe a picture into it on request.

Add a Paint panel, opened from the composer or from any Message. The writer types an optional Ask, a model writes a Brief from it through the Chat's Paint Preset, the writer edits the Brief and its reference pictures, and an Image Model paints.

Keep each painting as an Illustration belonging to the Variant it was painted from, shown in its own row after that Message. An Illustration never enters a Prompt Plan. The writer who wants the story model to see one adds it to their next Message.

## User Stories

### Appearance

1. As a writer, I want each character to have an Appearance holding a description and pictures, so that how they look is recorded in one place.
2. As a writer, I want a Participant seeded from a Character to copy its Appearance, so that a new Chat starts with the character's look.
3. As a writer, I want to turn off sending a character's Appearance pictures, so that models receive the description and picture names only.
4. As a writer, I want that switch on the Character to be the default and the Participant's copy to be that Chat's own setting, so that I can decide per Chat without a second setting.
5. As a writer, I want the Portrait left out of Appearance until I insert it, so that artwork never reaches a model without my choosing it.
6. As a writer, I want the built-in story preset to send Appearance after each seated character's Identity, so that the story model knows how they look without my editing a preset.
7. As a writer, I want to add an Appearance block to any other preset, so that imported presets can use it too.
8. As a writer, I want an empty Appearance to add nothing to a prompt, so that existing Chats are unchanged until I fill one in.

### Describing pictures

9. As a writer, I want to open a picture in Appearance and have a model describe it, steered by my Ask, so that each picture has a description beside it.
10. As a writer, I want a button on Appearance that describes the whole character from all its pictures, so that I get one description of their look.
11. As a writer, I want that button to use the Portrait when Appearance has no pictures, so that a character with only a Portrait gets a description in one press.
12. As a writer, I want the description added to my text without replacing anything, so that I can undo or edit it.
13. As a writer, I want to choose once, for the whole app, which model describes pictures, so that it works in the Character library where no Chat is open.

### Painting

14. As a writer, I want to open the Paint panel from the composer or from any Message, so that I can illustrate the current scene or an older one.
15. As a writer, I want to say what to paint in my own words, so that I can point at a moment and add direction.
16. As a writer, I want an empty Ask to mean the scene at the Message I opened the panel from, so that one press is enough.
17. As a writer, I want a model to write the Brief from my Ask and the recent Messages, so that I do not have to write image prompts.
18. As a writer, I want the Brief writer to read the Appearance of every Cast member in the scene, whether or not anyone is playing them, so that a third character is painted as they look.
19. As a writer, I want to edit the Brief, or type or paste my own without asking a model, so that I control what is painted.
20. As a writer, I want every Appearance picture of the characters the Brief names added as references, so that the painting looks like them.
21. As a writer, I want to add and remove reference pictures, so that I decide what the Image Model sees.
22. As a writer, I want to choose how many recent Messages the Brief writer reads, defaulting to five, with All as a choice, so that a long Chat does not make a Brief expensive.
23. As a writer, I want Lore that matches those Messages included, so that characters outside the Cast are described.
24. As a writer, I want to choose among five picture shapes, remembered per Chat, so that a portrait can be tall and a race can be wide.
25. As a writer, I want every painting to start with my press and make one picture, so that nothing spends money without me.
26. As a writer, I want the composer's Paint button to wait while a reply is still arriving, so that the current scene includes that reply.

### Paint Presets

27. As a writer, I want a built-in Paint Preset every Chat starts on, so that painting works without setup.
28. As a writer, I want to edit a Paint Preset in the ordinary preset editor, so that I can change how Briefs are written, including their art style.
29. As a writer, I want my edits to the built-in Paint Preset to reach every Chat using it, so that I tune it once.
30. As a writer, I want to pick another Paint Preset for one Chat, including my story preset once it holds a Brief instruction, so that a Chat can have its own style.
31. As a writer, I want the Brief instruction left out of story Generations, so that one preset can serve both without the story model seeing it.

### Illustrations

32. As a writer, I want a painting to continue after I close the panel, so that I can keep writing.
33. As a writer, I want to send, continue, swipe and edit while a picture is being painted, so that a slow painting never blocks the story.
34. As a writer, I want a finished picture shown in its own row after the Message it was painted from, as wide as the text and opening full size when pressed, so that it sits with the moment it shows.
35. As a writer, I want a picture to show and hide with the swipe it was painted from, so that a different reply never shows a picture of the old one.
36. As a writer, I want a failed painting to show the provider's message with Retry and Dismiss, so that I can see a refusal and try again.
37. As a writer, I want deleting a Message or swipe to cancel its painting and delete its pictures, so that nothing is left behind.
38. As a writer, I want to reopen an Illustration's Brief, change it and paint again, so that I can refine a picture.
39. As a writer, I want to delete an Illustration, so that takes I do not like are gone.
40. As a writer, I want Illustrations never sent to the story model, so that pictures do not add cost to every Generation.
41. As a writer, I want to add an Illustration to the composer, so that I can show it to the story model in my next Message when I choose to.
42. As a writer, I want a Fork to copy the Illustrations of the Messages it copies, so that a forked Chat keeps its pictures.

### Gallery

43. As a writer, I want the Paint panel to show this Chat's Illustrations from every swipe, so that I can find a picture under a swipe I moved away from.
44. As a writer, I want it to show the pictures in this Chat's Messages and the Cast's Portraits and Appearance pictures too, so that I can reuse them as references.
45. As a writer, I want to add any gallery picture to the composer or to the Brief as a reference, so that reuse takes one press.

### Models

46. As a writer, I want to choose one Image Model for the whole app in Connection Settings, with the picker I already know, so that I set it up once.
47. As a writer, I want to connect OpenRouter's Image API or any OpenAI-shaped image endpoint, so that I am not tied to one provider.

## Implementation Decisions

1. **Appearance channel.** Add `appearance` to the Prompt channels of every Definition, edited in the shared `ProseEditor` like the others. Add the preset references `human-appearance` and `model-appearance`, each starting with the role of the first matching Identity block in the preset, or that Identity reference's existing default role when none is present. This is only its starting role; the writer can change it. A migration adds both to the built-in Default preset, each right after its Identity block. A side whose Identity block the writer has deleted gets no Appearance block, and where an Identity block repeats, each added Appearance takes the role of the Identity block it follows. An empty channel renders nothing.
2. **Appearance switch.** A Definition holds a boolean, on by default, copied with the Definition. When off, every consumer reads that Definition's Appearance References as Image Anchors: the Prompt Plan, the Brief request, and the references the Paint panel adds.
3. **Describe.** One server route takes Image hashes and an optional Ask and returns text from the describing model, through the existing Model Client. The instruction is built in: face, hair, eyes, build, clothing and distinguishing marks, nothing about personality, followed by the Ask. The image viewer opened from a picture in Appearance sends that picture and inserts the text right after its Reference. The Appearance field's button sends every Appearance picture, or the Portrait when there are none, and appends the text. Neither replaces existing text. Describe refuses before sending when the describing model is marked Text-only. Describe sends each distinct Image once, in order of its first Reference.
4. **App-wide selections.** The Image Model and the describing model are each a Connection Profile and model, stored like a Box's Decision Model selection under host namespaces in `library_data`, and edited in Connection Settings with the existing profile-and-model picker.
5. **Image Model wire.** Add `images` to the API Formats. The Model Client calls the AI SDK's `generateImage` with the provider's image model: `imageModel()` from `@openrouter/ai-sdk-provider` for the OpenRouter adapter and from `@ai-sdk/openai-compatible` for the OpenAI-compatible adapter. The prompt is the Brief's text with its reference Images, which the OpenRouter provider sends as `input_references`. Returned bytes go through the existing Image ingest; a media type it rejects fails the painting. Add a Connection Preset for OpenRouter's Image API. The OpenRouter adapter sends the shape as `aspect_ratio`. The OpenAI-compatible adapter's image model has no aspect-ratio argument, so the shape goes in the request body as `aspect_ratio` through provider options; an endpoint that refuses the field fails the painting with the provider's message.
6. **Paint Preset.** Add a second built-in, non-deletable preset, "Default (Paint)", holding a Cast Appearance block, Lore, history and a Brief instruction. Each Chat stores a Paint Preset selection beside its story selection, starting on the built-in one; Fork copies it, and deleting a preset reassigns the Chats painting with it to the built-in one. The Paint picker lists the presets that hold an enabled Brief instruction. Art style is text in the Paint Preset; there is no separate style setting.
7. **Brief instruction slot.** A new single-use preset slot with authored text and a role. A Generation's Prompt Plan skips it. A Brief request includes it.
8. **Cast Appearance block.** A new single-use preset reference, `cast-appearance`. A Generation's Prompt Plan skips it. In a Brief request it renders the Appearance of every Cast member who authored one of the Messages being read or whose name appears in them or in the Ask, seated or not, each under its name.
9. **Brief request.** Compiled through the existing Generation Plan seam with the Chat's Paint Preset and Generation Settings. History is the last N Messages of the Selected narrative path ending at the Message the panel was opened from, or the final Message when opened from the composer. N is stored per Chat, defaults to 5, and may be All. Lore scans those Messages. No Box is captured, so Box blocks render nothing. No Macro State is written. The Ask is always sent as the final human message, after everything the preset places; an empty Ask sends a built-in line naming the scene at that Message. The reply streams into the panel and is stored nowhere.
10. **Brief.** Text with Image References, edited in the `ProseEditor`. Reference pictures are its References. After a model writes the Brief, the panel appends every Appearance Reference of each Cast member whose name appears in it and whose switch is on, with no cap. The Image Model receives the text with each Reference as its Image Anchor, and the Images in order.
11. **Provisional paintings.** The server holds paintings in progress in memory, keyed by Variant, and announces each start, finish and failure through `announceChange`. One press starts one painting of one picture. A failure keeps the provider's message until the writer retries or dismisses it. A painting whose Variant is removed is aborted, using the removed Variants the write observer already reports. A server restart drops them all.
12. **Painting from the composer.** The composer's Paint button is disabled while the Chat has an Active Generation. Painting from a Message that is not being generated is always available.
13. **Illustration storage.** A finished painting is one `message_variant_data` row under a host namespace. Its value holds the picture as `image:<hash>`, the Brief text, the Ask, the Image Model and the shape. The picture and the Brief's references are therefore found by the orphan sweep. Writing or deleting it changes no Conversation Revision and reports no touched Variant, so no Box digests again. Fork, Trim Variants and Variant deletion already handle such rows.
14. **Illustrations read.** One read per Chat returns its Illustrations, provisional paintings and failures by Variant, and follows the change feed. The story view renders a row after a Message for each Illustration of the Variant it is showing. The row is as wide as the text column and at most about half the viewport tall, and its height is reserved from the shape as soon as the painting starts. The story viewport follows the bottom when a row is added under the final Message, as it does for a new Message. The Paint panel shows the same rows for the Variant it is open on, so a painting's progress, picture or failure is visible there.
15. **Illustration actions.** Pressing the picture opens it full size. Add to composer inserts an Image Reference named with the first words of the Ask, or "Illustration" when there was none. Edit Brief and repaint opens the Paint panel on the stored Brief. Delete removes the row.
16. **Shape.** Five choices, sent as the aspect ratios 9:16, 3:4, 1:1, 4:3 and 16:9. The choice is stored per Chat. A Chat starts on 1:1.
17. **Gallery.** One server query per Chat returns, without duplicates, the Chat's Illustrations from every Variant, the Image References in every Variant of its Messages found by the shared parser, and the Cast's Portraits and Appearance References. The client cannot build it, since it loads Messages in pages and holds only the selected Variant's text. Each picture has Add to composer and Use as reference, which insert an Image Reference into the composer or the Brief.
18. **Design language.** The panel, the picture row, the provisional and failed states and the gallery follow DESIGN.md.
19. **Database workflow.** Schema changes follow the SQLite and Drizzle workflow. Seed data that gains Appearance gets a matching teardown.

## Testing Decisions

1. Test observable behavior: captured outgoing provider requests, stored state and command outcomes. No tautological tests and no architecture assertions.
2. The e2e `llm` fake gains scripted image and describe replies, so an unscripted painting or description fails the test as other provider calls do.
3. Appearance: prove through captured requests that the built-in story preset sends it after Identity, that an empty one sends nothing, and that the switch off sends anchors without Images to a Generation and to a Brief request.
4. Brief request: prove it uses the Paint Preset, includes the Brief instruction, ends with the Ask, reads exactly the last N Messages ending at the chosen Message, includes matching Lore and no Box block, and carries the Appearance of an unseated Cast member named in those Messages. Prove a Generation on a preset holding a Brief instruction and a Cast Appearance block sends neither.
5. Painting: prove the Image Model request carries anchors and no hashes in its text, the reference Images in order and the chosen aspect ratio, and that the result is stored through ingest.
6. Illustrations: prove one lands under a Variant that is no longer selected, lands without changing the Conversation Revision, is absent from every Prompt Plan, is copied by Fork and dropped by Trim Variants, is deleted with its Variant, and keeps its picture and references through the orphan sweep. Prove a painting is aborted when its Variant is deleted and that a failure carries the provider's message.
7. Describe: prove the request carries the chosen pictures, or the Portrait when Appearance has none, and the Ask.
8. No UI tests. Verify the panel, the picture row, the gallery and the Appearance editor manually in the browser with playwright-cli, including a picture arriving under the final Message and above the viewport.

## Out of Scope

- Automatic painting of new replies, and spend limits.
- More than one picture per press.
- Showing what a painting cost. The OpenRouter provider drops the cost the API reports.
- A per-Chat style setting apart from the Paint Preset.
- Painting a Portrait.
- Chat models that reply with pictures.
- Local diffusion backends.
- Mapping shapes to pixel sizes for endpoints that take `size` only, such as OpenAI's own.
- A per-Chat Image Model.
- An editable Describe instruction.
- Selecting text in the story to paint from.
- Gallery pictures from the Author Note, Openings, Macro Variables or other Chats.
- Short text descriptions of unseated Cast members in story Generations (#235).
- Sprites, which are a Box (#234).

## Further Notes

ADR-0054 records the decision and the alternatives rejected. Appearance, Image Model, Brief, Ask, Paint Preset, Brief instruction, Cast Appearance Block and Illustration are defined in GLOSSARY.md. This spec reverses two lines of the image-handling spec's Out of Scope: image generation, and automatic text description of Images, the second only for descriptions the writer asks for.

The cost of a Brief request has not been measured. It shares no provider cache with the story, which is why it reads five Messages by default.
