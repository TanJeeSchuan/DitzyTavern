# DitzyTavern

DitzyTavern is a chat-writing tool. A Conversation is the primary object people create and work in; Conversations can be created natively or brought in from an external chat import, and everything downstream — generation, history, provenance — is expressed in ordinary Conversation terms.

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

**Revision window**:
The two latest model-authored Messages and the Human-authored Messages between them. Variant selections inside this window may change the Selected narrative path without entering Preview mode.
_Avoid_: mutable tail, recent history

**Preview mode**:
A temporary view of one Variant outside the Revision window. It does not change the Selected narrative path unless the user confirms it.
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
