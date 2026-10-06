# DitzyTavern

DitzyTavern is a chat-writing tool. A Conversation is the primary object people create and work in; Conversations can be created natively or brought in from an external chat import, and everything downstream — generation, history, provenance — is expressed in ordinary Conversation terms.

**Chat**:
The everyday word for a Conversation, used in the workspace list, the active-chat header, and UI copy; no Chat subtype exists.

## Characters

**Definition**:
The complete authored identity of a Character or Participant: a nonblank name, a typed Prompt, ordered openings, and an optional Portrait. Seeding a Participant copies the whole Definition; no part of it stays linked to its source.
_Avoid_: card fields, character data

**Character**:
An optional, reusable library source owning one Definition. Editing or deleting a Character never changes the Participants it seeded.
_Avoid_: card, persona

**Participant**:
A Conversation-local identity owning its own copied Definition and, optionally, the provenance of the Character that seeded it. Message authorship and Control seats refer to Participants.
_Avoid_: Character when referring to the Chat-local copy

**Cast**:
The ordered roster of a Chat's active Participants. A Participant stays in the Cast whether or not it occupies a Control seat.
_Avoid_: party, members

**Portrait**:
The Image that visually represents a Definition, together with the focal point that stays visible whatever the shape of the frame showing it. A Portrait never enters a Prompt Plan; showing it to a model takes an Image Reference.
_Avoid_: avatar, profile picture

## Generation

**Generation**:
The process that turns a Conversation's writing context into model-produced candidate writing.
_Avoid_: response generation, reply generation

**Generation attempt**:
One request to a model made as part of a Generation.
_Avoid_: response, API call

**Active Generation**:
A Generation that the server has accepted but whose Generation attempt has not reached a terminal outcome.
_Avoid_: client stream, pending response

**Provisional Variant**:
The server-owned Variant that receives an Active Generation's output. It becomes durable after visible output arrives and is removed if the Generation terminates without output.
_Avoid_: client placeholder, streaming response

**Generation checkpoint**:
A durable snapshot of an Active Generation's accumulated Content, Reasoning Content, and latest persisted event position.
_Avoid_: autosave, stream event

**Generation resolution**:
The transition that turns an Active Generation's provisional target into a durable terminal Variant, advances the Conversation Revision, and removes the Active Generation record.
_Avoid_: generation completion, variant finalization


**Generated Variant**:
A Variant produced by a Generation attempt and retained as part of the Conversation.
_Avoid_: response, completion

**Tail Generation**:
A Generation whose Generated Variant begins a new Message at the current end of a Conversation.
_Avoid_: new response, normal generation

**Continuation Generation**:
A Tail Generation started without a new Human-authored Message. It continues from the existing Selected narrative path.
_Avoid_: empty message, blank submission, appended continuation

**Generation intent**:
The purpose of a Generation attempt expressed without provider-specific roles. A Generation may respond to a Human-authored Message or continue the existing Selected narrative path.
_Avoid_: generation type, synthetic user message

**Continuation strategy**:
The Generation setting that tells a model adapter to request continuation through an ephemeral instruction or an assistant prefill.
_Avoid_: continue mode, provider role

**Prefill suffix**:
Whitespace appended to the preceding model text only while constructing an assistant-prefill request. It may be empty, a space, a newline, or two newlines and never changes stored Message content.
_Avoid_: continue postfix, message separator

**Continuation instruction**:
Editable Conversation guidance used by the instruction Continuation strategy to request more writing without repetition. It is part of the Prompt Plan but not Conversation history.
_Avoid_: continue nudge, synthetic Message

**Generation Settings**:
The Conversation-owned configuration a new Generation starts from: model selection, sampling parameters, budget fields, Continuation strategy, and Request Overrides. Endpoints, credentials, and transport details belong to Connection Profiles instead.
_Avoid_: connection settings, generation config, Model Settings

**Stream Inactivity Timeout**:
The Connection Profile's maximum quiet interval for one Generation attempt; null or zero disables it. A stream quieter than this is aborted with the `inactivity` failure kind. It is never a total Generation duration.

**Effective Generation Settings**:
The Generation Settings that actually participate in one Generation attempt after its Generation intent determines which settings apply. They describe the attempt rather than merely copying the Conversation's configured values.
_Avoid_: configuration snapshot, raw Generation Settings

**Prompt Plan**:
The provider-neutral, ordered writing context compiled for one Generation attempt, including its named prompt blocks, selected Conversation history, and Generation intent.
_Avoid_: compiled prompt, provider messages, request payload

**Prompt Preset**:
A shared, reusable ordered recipe for assembling character information, instructions, and Conversation history into a Prompt Plan. Conversations using the same Prompt Preset share its saved edits; an independent recipe is a copy of the entire preset. Generation Settings and text-processing scripts are outside its scope.
_Avoid_: Generation Settings, Connection Preset, Prompt Plan

**Referenced Prompt Block**:
A Prompt Preset slot whose content comes from the Conversation or a Participant Definition rather than text authored in the preset. Its source text is read-only in the preset editor.
_Avoid_: foreign prompt block

**Prompt Macro**:
An expression in authored prompt text that contributes text or controls what enters a Prompt Plan using the available writing context.
_Avoid_: placeholder when referring to macros that take arguments or control content

**Prompt Comment**:
An annotation enclosed in `{{// ... }}` that remains in authored prompt text but contributes no text to the Prompt Plan.
_Avoid_: instruction block, unknown macro

**Macro Variable**:
A named value scoped to one Conversation and one Prompt Preset that Prompt Macros can read and change, retained between Generations.
_Avoid_: temporary template value, Participant attribute

**Macro State**:
The values of one Prompt Preset's Macro Variables within a Conversation at a point in its Selected narrative path. Alternative Variants may have different resulting Macro States.
_Avoid_: global variable store, memory tool result

**Generation Plan**:
The complete application plan for one Generation attempt: its Prompt Plan, budget decision, and Effective Generation Settings.
_Avoid_: Prompt Plan, model request, generation configuration

**Request Overrides**:
Extra request body fields owned by the Conversation and grouped by API Format namespace. Only the namespace matching the active Connection Profile's format is merged into each request; the other namespaces are kept editable and never transmitted. Overrides never replace structural request framing such as messages, stream behavior, or the managed output limit.
_Avoid_: custom payload, raw request editing

**Sibling Generation**:
A Generation whose Generated Variant becomes another Variant of an existing Message.
_Avoid_: regenerate, swipe generation

**Selected narrative path**:
The ordered history formed by taking the selected Variant of each Message. Tail Generation uses the path through the end; Sibling Generation uses the path strictly before its target Message.
_Avoid_: active branch, current responses

**Token estimate**:
An approximate measure of a Prompt Plan's input size before a Generation attempt. It is neither an exact provider token count nor proof that the provider will accept the request.
_Avoid_: token count, exact tokens

**Safety allowance**:
A configurable token reserve added to the Token estimate before checking a Prompt Plan against its context limit. Its default is 500 tokens and it is not a statistical uncertainty range.
_Avoid_: error bound, token variance

**Estimation transcript**:
A deterministic single-text representation of an ordered Prompt Plan used only to obtain its Token estimate. It is never sent to the model.
_Avoid_: serialized prompt, provider request

**Preview mode**:
A temporary view of a different Variant on a Message that has later Messages. It does not change the Selected narrative path unless the user confirms it. Switching the final Message's Variant applies immediately.
_Avoid_: pending selection, draft branch

**Confirm Change**:
The action that makes a previewed Variant part of the Selected narrative path. Messages after the changed Variant remain unchanged.
_Avoid_: apply preview, commit branch

**Human-authored Message**:
An ordinary Message produced by the human-controlled Participant. Guidance and in-character writing are usage styles, not different Message types.
_Avoid_: guidance record, instruction message

**Message authorship**:
The Participant responsible for producing a Message, independent of any fictional speakers or actions represented inside its content.
_Avoid_: detected speaker, character attribution

## Images

**Image**:
A picture stored once by its content, so the same picture is one Image wherever it appears. Portraits and Image References name it. Images are uploaded through one endpoint and start orphaned. Startup scans all persisted owners to clear or set orphan timestamps, then deletes Images orphaned for more than 24 hours.
_Avoid_: attachment (reserved for Lorebook Attachment), upload, file

**Image Reference**:
The inline mention of an Image, carrying a writer-visible name, inside Message, Prompt channel, Opening, or Macro Variable text. Its position in the text is the Image's position in the writing. A Reference produced by a Prompt Macro counts the same as one the writer typed.
_Avoid_: attachment, embed, inline image

**Repeated Image Placement**:
The Generation Setting that decides which References to an Image appearing more than once in a Generation send the Image: the first, the last, or every one. The rest send only their Image Anchor.
_Avoid_: image dedupe, image cache

**Image Anchor**:
The text form of an Image Reference, naming the Image without its identity. Everything that reads writing as text sees the Image Anchor in place of the Image; a model receiving the Image sees the Image Anchor immediately before it.
_Avoid_: alt text, caption, image description

**Text-only Model**:
A model that a Connection Profile marks as unable to receive Images. Generations using it send each Image Anchor without its Image. The writer applies the mark, usually after a Generation containing Images fails; it is never inferred from a provider error.
_Avoid_: non-vision model, image fallback

## Decisions

**Decision Model**:
A model that answers typed questions about a supplied state with probabilities instead of writing text. Memory judgment, Memory recall and Semantic Trigger matching each ask a Decision Model.
_Avoid_: classifier, classification model, Jev when naming the role rather than one product

## Memory

**Memory**:
Information about story events, facts, relationships, and what characters know or believe, learned from a Conversation and retained to support continuity within that Conversation.
_Avoid_: Lore Entry when referring to information learned from Conversation history

**Memory Claim**:
A statement retained in a Memory about a story event, fact, relationship, or fictional person's perspective. Its attribution distinguishes what the story establishes from what someone says, witnesses, or believes.
_Avoid_: verified fact when the source only establishes an assertion or belief

**Memory Evidence**:
The Conversation passages supporting a Memory Claim, including who says or experiences what they describe.
_Avoid_: model confidence

**Character Belief**:
What a fictional person believes, as established by the Conversation. Hearing a claim does not by itself establish belief in it; an unstated belief remains unknown.
_Avoid_: story fact, model confidence

**Memory Collection**:
The Memories owned by one source Variant. A collection becomes writer-maintained when the writer edits or removes a Memory, and returns to automatic ownership only through an explicit reset.
_Avoid_: Lorebook, conversation-wide memory when referring to one source's collection

**Memory Block**:
A prompt block containing story-wide Memories selected for a Generation, including their character-knowledge and belief attribution, separate from Conversation history.
_Avoid_: history summary, Lore Block

**Memory Allowance**:
The maximum estimated token space allocated to a Memory Block, distinct from Conversation history; available prompt space can restrict it further.
_Avoid_: context limit, history window

## Lorebooks

**Lorebook**:
A shared, reusable collection of Lore Entries. Chats using the same Lorebook share its saved edits; an independent version is a duplicate of the book.
_Avoid_: World Info when naming DitzyTavern's native concept

**Lorebook Attachment**:
An association between a Lorebook and a Character, Participant or Chat. The attachment owns the scope of that use; the Lorebook remains independent of its attachments.
_Avoid_: scoped lorebook

**Lorebook Attachment Scope**:
The condition under which an attachment makes its Lorebook eligible: Controlled Participant requires its Participant to occupy either control seat, Cast requires its Participant to belong to the Chat's Cast, and Chat applies independently of Participants.
_Avoid_: lorebook tag, Participant scope when referring specifically to control-seat eligibility

**Lore Entry**:
A unit of authored lore content together with the conditions describing when it is relevant to a Conversation.
_Avoid_: memory when referring to authored lore

**Keyword**:
An authored lexical trigger for a Lore Entry, separate from its Semantic Triggers.
_Avoid_: Semantic Trigger

**Semantic Trigger**:
An author-written phrase describing a context in which a Lore Entry is relevant by meaning. It is separate from the entry's Keywords and lore content.
_Avoid_: embedded keyword, entry content

**Lore Scan Window**:
The recent Messages whose text determines which Lore Entries are relevant for a Generation. Both Keywords and Semantic Triggers examine this window within the Generation's Selected narrative path.
_Avoid_: context window, Prompt Plan

**Always Entry**:
A Lore Entry whose relevance does not depend on Keywords, Semantic Triggers or secondary Keyword conditions.
_Avoid_: matched entry

**Lore Block**:
A Referenced Prompt Block containing the Lore Entries selected for a Generation. The Prompt Preset determines its placement and role.
_Avoid_: Lorebook, Lore Entry

**Lore Allowance**:
A Chat's limit on the estimated token space allocated to lore in a Generation. The available prompt space can restrict lore further.
_Avoid_: context limit, guaranteed lore reservation

**Lore Activation Record**:
The retained explanation of which lore a Variant's Generation considered and included or omitted, together with the evidence for those decisions. It describes that attempt even after its source Lorebooks change.
_Avoid_: current match test, full Prompt Plan

**Secondary Keyword Condition**:
An additional lexical requirement or exclusion for a conditional Lore Entry, regardless of whether its primary match came from Keywords or Semantic Triggers.
_Avoid_: semantic exclusion

## Chat provenance and imports

**Native Conversation**:
A Chat created by importing an external chat is an ordinary native Conversation; there is no lasting imported subtype, badge, or capability mode.
_Avoid_: imported chat, imported subtype

**Conversation-scoped data**:
Structured values attached to a Conversation under a (namespace, key) pair. The owning domain decides the namespace and the meaning of its values; Conversation stores and returns them without interpreting them.
_Avoid_: chat data rows

**Import provenance**:
The immutable record that a Chat came from an external import: the original filename, the byte SHA-256 and the advisory integrity, message/variant counts, the importer version, and warnings. Present only for imported Chats.
_Avoid_: import badge, import marker

**Import receipt**:
The compact structured form of Import provenance persisted at commit (source identity, counts, warnings, importer version) and shown in Import Details.
_Avoid_: import report, source report

**Prior import**:
An earlier Chat whose Import provenance matches the source under review.
_Avoid_: duplicate, match, copy

**Duplicate evidence**:
The classified Prior imports for a source: exact (matching raw-byte SHA-256) or related (matching only the advisory integrity).
_Avoid_: duplicate matches

**Duplicate warning**:
A warning composed when importing a source that already matches a Prior import; importing always creates an independent copy, never a dedupe.
_Avoid_: duplicate notice

**Exact Source Artifact**:
The immutable original import bytes stored under a managed path and tied to its Conversation. A missing or corrupt copy reports **cleaned up** and only disables exact download; the native Chat is unaffected.
_Avoid_: original file, raw bytes

**Canonical Source Archive**:
The immutable parsed source values preserved in Conversation-scoped data for an imported Chat; never rewritten by later native edits.
_Avoid_: source dump

**Cleaned up (artifact)**:
The state where a Chat's Exact Source Artifact copy is missing or corrupt. Provenance is lost but ordinary Conversation behavior is unaffected; only exact download is disabled.
_Avoid_: deleted, lost file

**Unreadable Import Provenance**:
The state where an imported Chat's persisted Import provenance cannot be decoded; Import Details degrades to an explicit notice instead of silently reporting none.
_Avoid_: missing import, no provenance

**Import Details**:
The read of an imported Chat's provenance: its Import receipt, current Duplicate evidence, and Exact Source Artifact availability. A Chat without Import provenance simply has none.
_Avoid_: import info, provenance panel
