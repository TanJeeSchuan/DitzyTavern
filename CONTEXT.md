# DitzyTavern

DitzyTavern is a chat-writing tool. A Conversation is the primary object people create and work in; Conversations can be created natively or brought in from an external chat import, and everything downstream — generation, history, provenance — is expressed in ordinary Conversation terms.

## Generation

**Generation**:
The process that turns a Conversation's writing context into model-produced candidate writing.
_Avoid_: response generation, reply generation

**Generation attempt**:
One request to a model made as part of a Generation.
_Avoid_: response, API call

**Generated Variant**:
A Variant produced by a Generation attempt and retained as part of the Conversation.
_Avoid_: response, completion

**Tail Generation**:
A Generation whose Generated Variant begins a new Message at the current end of a Conversation.
_Avoid_: new response, normal generation

**Sibling Generation**:
A Generation whose Generated Variant becomes another Variant of an existing Message.
_Avoid_: regenerate, swipe generation

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

**Import Details**:
The read of an imported Chat's provenance: its Import receipt, current Duplicate evidence, and Exact Source Artifact availability. A Chat without Import provenance simply has none.
_Avoid_: import info, provenance panel
