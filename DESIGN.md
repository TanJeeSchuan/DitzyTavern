# DitzyTavern Design Direction

## Status and scope

This document is the visual and interaction design source of truth for the first DitzyTavern interface pass. It defines intended outcomes and constraints. It does not select frameworks, component libraries, packages, or implementation techniques.

The initial scope excludes group-chat orchestration, a dedicated co-writer response role, automatic identification of individual speakers inside generated prose, and logo design.

Amendments to the initial direction (replacing earlier single-identity composer guidance): the composer exposes **two editable Cast-only Control selectors** — `Writing as <human>` and `Responding as <model>` — reflecting the current human and model Control assignments. Selecting the opposite seat's occupant is described as an atomic swap. Portraits show uploaded artwork wherever identity is rendered, falling back to initials when a Definition has none; character-derived ambient color remains **deferred**. Active/inactive Cast membership and group-chat turn-taking remain out of scope; the Cast is an ordered roster of active Participants with append-only positioning.

## Project and page intent

DitzyTavern is a cooperative AI writing and roleplay workspace. Its primary use is not full in-character roleplay. The user usually plays the human-controlled Participant, often a persona named Writer, giving guidance that the model incorporates into story prose featuring the active cast.

The active Chat is the primary surface. The interface should help the user read an evolving story, guide the next generated Message, inspect how a Message was produced, edit it, and move between alternative Swipes without turning the experience into either a plain document editor or a dense control console.

Full roleplay remains possible by choosing a character for the human Control seat instead of the default guidance persona. This secondary use must remain clear and accessible without defining the default visual grammar.

## Audience

The primary audience is SillyTavern power users. They understand character cards, Chats, Messages, prompts, generation settings, and Swipes. They value detailed control and provenance, but should not be required to tolerate the visual clutter common to power-user roleplay tools.

The design should feel like a recognizable evolution of familiar mental models. It should not resemble a lightly reskinned SillyTavern interface.

## Design Read

Reading this as: a cooperative AI writing and roleplay workspace for SillyTavern power users, with a warm, precise writing-studio language, leaning toward a custom application design system with familiar chat mechanics and restrained character atmosphere.

## Three dials

- `DESIGN_VARIANCE: 4`
  - The central story follows a disciplined, repeatable rhythm.
  - Character and atmosphere come from content, identity, and ambient color rather than irregular layouts.
- `MOTION_INTENSITY: 5`
  - The interface feels gently responsive.
  - Motion communicates hierarchy, feedback, reading state, and generated-content arrival.
- `VISUAL_DENSITY: 5`
  - This is a balanced workspace.
  - The Chat remains dominant while common actions and nearby context remain available.

## Aesthetic family and design-system direction

The aesthetic family is a writing studio with chat mechanics.

The visual system should combine:

- The precision and hierarchy of a focused productivity tool.
- The reading comfort of a long-form writing environment.
- The identity and companionship of a character-driven roleplay tool.
- A restrained suggestion of a shared room around the writing surface.

This is a custom product design language, not an imitation of a named public design system. It should preserve recognizable SillyTavern concepts while recomposing their visual hierarchy around cooperative writing.

## Brand personality

DitzyTavern should feel:

- Warm and companionable.
- Adult and understated.
- Precise without being sterile.
- Capable without appearing intimidating.
- Character-aware without becoming theatrical.
- Calm enough for long reading and writing sessions.

Warmth must not become cute, rustic, faux-medieval, or whimsical.

## Visual principles

1. **The story is the primary artifact.** Prose receives the clearest reading surface and the least decorative chrome.
2. **Human guidance is visible causality.** Human-authored guidance Messages remain readable in the timeline with their captured author identity.
3. **Power follows a hierarchy.** Common actions remain visible. Advanced controls appear through hover, keyboard focus, touch selection, or an explicit details action.
4. **Identity is contextual.** Character artwork and authorship become prominent where they help the user understand who is involved or what produced a Message.
5. **Atmosphere surrounds the work.** Ambient color belongs to the outer application shell, never beneath prose or controls.
6. **Familiar concepts, calmer composition.** Retain Chat, Message, Prompt, and Swipe mental models without retaining dense legacy presentation.
7. **Stable reading geometry.** Opening tools must not shift or resize the central Chat on wide desktop layouts.

## Product vocabulary

- **Chat:** the conversation and story container.
- **Message:** any stored turn in a Chat, authored by a Cast Participant.
- **Guidance Message:** the human-controlled Participant's direction for what should happen next.
- **Prompt:** the assembled technical model input available through inspection.
- **Swipe:** an alternative version of a generated Message.
- **Writer:** an ordinary possible name for the human-controlled Participant; it carries no special domain behavior.

Interface copy should be plain and precise. Avoid literary euphemisms, faux-tavern terminology, and playful substitutes for standard actions.

## Typography direction

Use a deliberate two-voice sans-serif hierarchy:

- Application controls, navigation, metadata, and technical details use a crisp, compact sans with high small-size clarity.
- Story prose and human guidance Messages use a softly rounded humanist sans that feels companionable during long reading sessions.

The prose face must be restrained rather than bubbly. It should not resemble children's software or casual social messaging. The distinction between the two voices should be clear but harmonious.

Do not use a serif for the initial direction. Do not introduce a third display face. Use weight, scale, spacing, and the two established voices to create hierarchy.

## Color and theme direction

DitzyTavern supports an adaptive daylight and evening theme from the start.

- The default follows the operating-system preference.
- The user may manually choose daylight, evening, or system behavior.
- Daylight uses mineral-white tonal surfaces with dark charcoal text.
- Evening uses deep charcoal tonal surfaces with softly lifted text and controls.
- Both modes use the same neutral family and preserve equivalent hierarchy.
- Muted coral is the single interface accent across both themes.

Muted coral carries focus, selection, active authorship, and important actions. It should be calm enough for long sessions, with stronger values reserved for focus and primary action states.

Quoted dialogue in story prose uses a muted teal. It is the only hue inside prose, is never character-derived, and stays clear of coral so it never reads as interactive.

Character-derived color is allowed only in the decorative ambient field. It must be low-saturation, nonsemantic, and isolated from text, controls, focus states, status colors, and the central story canvas.

The ambient field responds to the current composer identity:

- A Participant named Writer uses the neutral brand ambience with a restrained coral influence.
- A selected character may gently influence the ambient field using colors derived from that character's artwork.
- Identity changes should produce a soft transition, not an abrupt recoloring of the application.

## Layout and composition rules

### Wide desktop frame

- The Chat occupies a fixed central story column with a comfortable reading measure.
- A slim persistent navigation rail sits at the far left.
- Space is reserved on both sides of the Chat for tools, so panel opening does not move the Chat.
- Primary panels open to the left of the Chat, between the navigation rail and story surface.
- Secondary and comparative panels open to the right of the Chat.
- Floating surfaces are the final level in the hierarchy and are reserved for brief or highly focused tasks.

### Narrow desktop and mobile frame

- The left navigation rail leaves the frame and opens as a labelled drawer from a menu button at the start of the Story header, so the Story keeps a single header bar.
- Tool panels become nested full-screen layers rather than compressed sidebars or small floating cards.
- Each layer needs an obvious back path and visible nesting context.
- Closing a layer returns the user to the same story position.
- Mobile has full authoring parity. It is not a companion or read-only experience.

### Reading geometry

- The central column uses a comfortable book-like line length.
- Generated Messages follow a consistent vertical rhythm.
- Paragraph spacing supports long-form reading.
- Message boundaries are defined by author headers, whitespace, and action placement rather than enclosing every Message in a card.
- The composition remains disciplined. Important Messages do not change scale or layout based on narrative drama.

## Spacing, geometry, radius, and materiality

- Use pronounced but disciplined softness.
- Panels and the floating composer have clearly rounded geometry.
- Portraits use compact squircle frames.
- Pills are reserved for compact selectors, statuses, or controls whose shape communicates their behavior.
- Do not place every label, action, or metadata value inside a pill.
- Use tonal layering as the primary material system.
- Separate neighboring surfaces through value, spacing, and sparse borders.
- Shadows are reserved for true floating hierarchy, such as the composer or an overlay. They should be subtle and tinted toward the surrounding theme.
- Do not use frosted glass, pervasive translucency, or decorative bevels.

The overall spacing is balanced rather than airy. The story needs breathing room, while rails, headers, and panels remain efficient enough for power use.

## Image and art direction

Character artwork is contextual:

- Compact squircle portraits support authorship and identity controls.
- Larger portraits appear in participant panels and focused author details.
- A new empty Chat begins with a quiet portrait row introducing the active cast.
- Portraits should preserve as much of imported character artwork as the available crop permits.

### Images in writing

Images placed in Messages, Prompt channels, Openings, and Macro Variable values stay part of the text:

- **Editor chips:** every editor that accepts Images draws each Image Reference as one chip: a 1.5rem rounded-square thumbnail beside the Image name, on a faint translucent tint (so a selection shows through) with a hairline border and a modest radius. The chip is centered on the text beside it, and the caret on either side stays text-height. Chips are not pills. The cursor and Backspace treat it as one unit, the text under it stays exactly what was typed, and clicking it opens the Image full size.
- **Adding Images:** a quiet icon button sits at the bottom right of each such editor and is visible without hover. Paste and drop insert at the cursor. Prompt Preset and Lore Entry editors have no such button.
- **Inline thumbnails:** in the story, a Reference is a compact thumbnail (at most 14rem by 6rem) with a hairline border, the same softness as panels, a zoom cursor, and a coral hover border and focus ring.
- **Full size:** activating a thumbnail opens a Dialog on the standard opaque popover surface. The Image name is the title, the picture is fitted to the viewport, and Escape or the close control returns to the same story position.
- **Missing Images:** a Reference whose Image is gone shows its `[Image: name]` anchor as muted inline text with no border and no interaction. In an editor the chip keeps its shape with a dashed border and no thumbnail.
- **Other image URLs:** an image URL that is not an Image Reference never loads and shows only its alt text.

The application shell uses abstract ambient light rather than literal environmental artwork. Soft, low-contrast color fields suggest a shared room around the writing desk. Do not depict a literal tavern, fireplace, wooden table, parchment, candles, or medieval ornament as recurring interface material.

The central story canvas, floating composer, and panels remain opaque and readable above the ambient field.

## Motion philosophy

Motion is gently responsive and always motivated.

- Panel transitions communicate depth and nesting.
- Hover, focus, press, and selection states provide immediate feedback.
- Author detail disclosure progresses from idle to partial to full without abrupt jumps.
- Newly generated prose appears a paragraph at a time with stable line wrapping.
- Do not simulate a theatrical typewriter.
- The floating composer recedes while the user reads older Messages and returns near the latest Message, on focus, or through a keyboard action. It stays open while a Generation runs.
- The story view glides to the latest content while the user is at the bottom, and stops following once they scroll up.
- Character-responsive ambient color transitions softly when the composer identity changes.

No ambient loops are required. No motion should compete with prose. Reduced-motion preferences must replace movement with stable, immediate state changes.

## Surface-level composition direction

### Application shell

- Slim icon-only desktop rail with immediate hover and keyboard-focus labels.
- Labelled navigation drawer, opened from the Story header, on narrow desktop and mobile.
- Abstract ambient field visible mainly around the fixed story canvas and unused utility bays.
- No decorative status dots or ornamental navigation treatments.

### Story header

- Persistently shows the Chat title.
- Includes one compact Cast control rather than listing portraits or names.
- The Cast control opens the primary left participant panel.
- Cast membership can change at any time.
- Generation profile does not appear globally because it belongs to individual Messages.

### New Chat empty state

- Begin with a quiet row of active-cast squircle portraits and names.
- Establish the social context before requesting the first guidance Message.
- Keep setup language short and functional.
- Avoid generic starter-prompt cards in the initial direction.

### Human guidance Messages

- Use the same open Message treatment as the rest of the timeline, without a separate tint or human-only mark.
- Use the captured Participant name and the rounded reading face.
- Stay visually subordinate to generated prose without becoming low-contrast.
- Current scope uses readable inline blocks.
- Margin annotations and a separate direction-history panel remain future explorations.

### Generated Messages

- Sit as open prose on the story canvas with no enclosing card.
- Use a strong Message header, but show only the author name at idle.
- Hover or keyboard focus reveals partial author and generation metadata.
- Touch selection exposes the equivalent partial state.
- An explicit details action opens full authorship, generation-profile, and provenance information.
- Do not add UI markers for individual fictional speakers inside prose.

### Message actions

- Every generated Message owns its own actions, not only the latest Message.
- Edit and Swipe controls appear on hover, keyboard focus, or touch selection. The latest Message keeps its actions visible.
- Swipe state uses plain positional text such as `2 of 4`.
- Previous and next controls, keyboard arrows, and touchscreen swipe provide equivalent variant navigation.
- Regenerate, inspect Prompt, copy, branch, remove, and other advanced actions appear through hover, keyboard focus, touch selection, or a compact overflow action.

### Floating composer

- Show the model chip directly in the toolbar. It opens one searchable picker, without an intermediate connection popover. Explain preview locks beside the chip.

- Use two editable, Cast-only Control selectors as quiet pills in the composer toolbar beside Send: the human seat (person glyph, accessibly labelled **Writing as**) and the model seat (sparkle glyph, reading "<name> replies", accessibly labelled **Responding as**), each reflecting the current assignment. The placeholder names the human seat (`What does <name> do next?`).
- Selecting the opposite seat's occupant is visibly described as a swap and performs one atomic exchange of the two assignments, so a two-Participant Cast can never become locked.
- Selecting an unseated Participant replaces only the chosen seat; the displaced Participant stays in the Cast and becomes removable.
- Neither seat can be cleared; the selectors offer only Cast Participants, named with computed duplicate labels.
- Incomplete imported Chats are the narrow exception to always-seated Control: an import that resolved fewer than two Participants keeps its history visible while a persistent setup panel names the empty seat(s) and withholds play actions. Adding the missing Participant fills only the empty seat and derives playability automatically; there is no separate imported mode.
- A guidance persona (often named Writer) simply means the human seat holds an ordinary Participant; it carries no special behavior.
- Character identity frames the submission as in-character writing, chosen through the same two seat selectors rather than a separate mode toggle.
- The composer floats above the lower edge of the central story surface as an opaque tonal layer.
- It recedes while the user reads older Messages and returns when writing intent resumes.
- It stays open while a Generation runs, because it holds the Stop control.
- It must not obscure the latest Message or create unstable content jumps.

### Live generation

- Each paragraph appears once it is complete and wipes in whole, a soft edge sweeping through it in reading order. A paragraph longer than a few sentences is released in sentence-aligned chunks that each wipe in at a steady pace, so long paragraphs still show progress. The opening sentence appears as soon as it ends.
- While the user is at the bottom, the view follows new content with a smooth scroll. A new Swipe or Regenerate on the latest Message returns the view to the bottom.
- Keep line wrapping and paragraph positions stable.
- Place a restrained generation-state indicator near the author header.
- Inspect sits in the Message's action row as a quiet action like Edit, in the slot Continue takes when the Generation ends, so finishing does not shift the story. Stop is the Composer's send button.
- Avoid blinking cursors, fake keystroke timing, or other theatrical effects.

### Panels and details

- Use the shared coral Switch, segmented control, input shape, and destructive Button across panels.
- Show validation errors after blur or a submit attempt, never on an untouched form.

- Left panels contain primary story context such as Cast and other first-order Chat controls.
- Right panels contain secondary detail, inspection, and comparison surfaces.
- Floating surfaces handle brief, focused tasks only.
- Full-screen mobile layers preserve the same hierarchy through nesting rather than side-by-side placement.

### Loading, empty, and error states

- Loading placeholders should mirror the final content shape and preserve layout stability.
- Empty states should explain the next useful action without decorative filler.
- Generation errors belong beside the affected Message and retain the failed context.
- Transient confirmation may use a temporary notice, but actionable errors must remain contextual.

## Relevant Reference Vocabulary

Use these patterns as vocabulary and intent, not as mandatory technical recipes:

- **Mesh Gradient Background:** only as a restrained, low-contrast ambient field around opaque work surfaces.
- **Morphing Modal:** useful as a conceptual model when a desktop panel becomes a full-screen mobile layer.
- **Skeleton Shimmer:** acceptable for shape-matched loading states, with restrained contrast and reduced-motion handling.
- **Lens Blur Depth:** relevant only to temporary focus states where a foreground layer must clearly dominate. It must not become a permanent glass effect.

Do not use Sticky-Stack Sections, Horizontal Scroll Hijack, kinetic marquees, parallax cards, magnetic buttons, text scramble, custom cursors, or cinematic scroll choreography.

## Responsive design principles

- Preserve the central reading measure on wide displays instead of stretching prose to fill available space.
- Reserve desktop utility bays so opening panels does not reflow the Chat.
- Replace side-by-side tools with full-screen nested layers when the viewport cannot support the complete frame.
- Convert the left rail to a Story header drawer on narrow desktop and mobile.
- Keep identity selection, Message submission, Swipe navigation, Edit, and author details fully operable on touch.
- Do not rely on hover for information or actions. Every hover state needs focus and touch equivalents.
- Preserve scroll position when opening and closing panels or changing Swipes.
- Keep targets comfortably usable by touch without turning all controls into oversized pills.

## Accessibility constraints

- Meet WCAG AA contrast for text, controls, focus indicators, placeholders, metadata, and all interactive states.
- Ambient character color is decorative and must not carry meaning.
- Story text and controls sit on opaque surfaces with stable contrast in both themes.
- All icon-only navigation and actions require accessible names and immediate visible labels on hover or focus where space permits.
- Keyboard focus must be highly legible across daylight and evening modes.
- Touch alternatives must exist for hover disclosure.
- Swipe gestures must always have visible button equivalents and keyboard equivalents.
- Motion must honor reduced-motion preferences.
- Streaming text must not cause avoidable layout shifts or steal focus.
- Theme choice must not reduce hierarchy or author-state clarity.

No additional specialized accessibility mode is part of the initial design direction. The general baseline must nevertheless be strong.

## Explicit anti-patterns

This design must not become:

- A conventional alternating chat-bubble interface.
- A stack of rounded cards around every generated Message.
- A dense cockpit with every control visible at once.
- A generic minimalist tool that removes character presence.
- A fantasy tavern simulation with wood, parchment, candles, crests, medieval type, or ornamental controls.
- A beige, brass, brown, and espresso craft palette.
- An AI-purple or blue-glow interface.
- A glassmorphism showcase.
- A cute companion app with bubbly type, mascots, or playful microcopy.
- A document editor that hides authorship, Swipes, or generation provenance.
- A layout where opening panels pushes or narrows the wide-desktop Chat.
- A hover-only interface.
- A pill-heavy interface.
- A layout with circular social-chat avatars.
- A theme where character-responsive ambience recolors semantic UI.
- A motion-heavy experience with ambient loops, scroll tricks, or typewriter theater.
- An interface that uses Prompt ambiguously for both a guidance Message and assembled model input.

Visible copy must not use em dashes, decorative section numbering, version stamps, poetic micro-labels, decorative status dots, or unnecessary tavern vocabulary.

## Open questions and deferred explorations

These items are intentionally nonblocking for the first design pass:

1. **Logo and brand mark:** the slim rail needs a compact identity treatment, but the logo form is deferred.
2. **Guidance Message alternatives:** margin directions and a separate direction-history surface may be explored after the inline block pattern is validated.
3. **Group chat:** multi-character response orchestration and criteria for deciding who responds are deferred and should not affect the initial layout.
4. **Dedicated co-writer actor:** a model role that responds explicitly as a co-writer is work in progress and outside this design scope.
5. **Character-level prose attribution:** automatic markers inside generated prose would require structured generation metadata or a second interpretation pass and are out of scope.

## Implementation handoff notes

- Treat this document as the authority for visual hierarchy and behavior. Do not replace the open-prose story surface with conventional bubbles for implementation convenience.
- Preserve the established domain vocabulary exactly unless a later product decision updates it.
- Prototype the fixed central story width together with both desktop utility bays before refining individual controls.
- Validate the composer identity control with the human seat's persona and character selections before designing secondary composer actions.
- Test long generated Messages, multiple Swipes, streaming, editing, errors, and provenance disclosure. A short successful Message is not a sufficient design test.
- Validate all idle, hover, focus, touch-selected, open, loading, streaming, and error states.
- Test daylight and evening themes with multiple character artworks. Character-derived ambience must remain restrained and must not contaminate semantic colors.
- Test narrow desktop and mobile as full authoring environments, including nested panel navigation and return-to-story position.
- Use real imported character artwork when validating portrait crops and ambient color behavior.
- Keep advanced controls discoverable without allowing them to dominate the idle reading surface.
- Do not resolve deferred items silently during implementation. Record and review any proposed expansion of scope.
