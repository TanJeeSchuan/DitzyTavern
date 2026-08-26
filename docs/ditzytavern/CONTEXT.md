# DitzyTavern

DitzyTavern is a cooperative writing and roleplay workspace in which reusable identities become independent participants in durable story conversations.

## Story and history

**Chat / Conversation**:
The durable story container. Chat is the product term; Conversation is the domain term for the same object.
_Avoid_: Session, thread

**Message**:
One authored turn at an ordered position in a Conversation. A Message owns one or more Variants and one immutable Author Stamp.
_Avoid_: Reply when referring to the stored turn

**Variant / Swipe**:
One alternative content value owned by a Message. Swipe is the user interaction; Variant is the retained alternative, exactly one of which is selected.
_Avoid_: Separate Message, regeneration copy

**Guidance Message**:
A normal Message authored by the human-controlled Participant to direct subsequent writing. It has no special stored role or identity.
_Avoid_: Prompt, Writer Message, instruction record

**Generation**:
One model attempt that produces either a new Message or another Variant of an existing Message.
_Avoid_: Message, Swipe when referring to the attempt itself

## Identity and participation

**Character**:
An optional reusable identity source containing a complete Definition. Using a Character creates an independent Participant rather than a live instance of the Character.
_Avoid_: Actor Profile, Profile, global Participant

**Character Library**:
The collection of active reusable Characters available for inspection, editing, and use as Participant sources.
_Avoid_: Profile Library, Cast

**Definition**:
The complete authored identity content owned independently by a Character or Participant: a name, a typed Prompt, and ordered Openings.
_Avoid_: Profile, Master Prompt, Participant Prompt

**Prompt**:
The typed instruction channels inside a Definition: System Instruction, Identity, Scenario, Example Dialogue, and Post-History Instruction.
_Avoid_: Guidance Message, Prompt Plan, Definition

**Opening**:
One authored candidate for the initial model-controlled Message. A Definition may own an ordered list of Openings, including no Openings or duplicate alternatives.
_Avoid_: Greeting Message when referring to configuration

**Participant**:
A Conversation-local identity with its own independent Definition. It may retain immutable Character Provenance, but it never synchronizes with that Character.
_Avoid_: Character when referring to a Cast member, Actor, role

**Ad-hoc Participant**:
A Participant created from a Conversation-local Definition without a source Character.
_Avoid_: Temporary Participant, unresolved Participant

**Character Provenance**:
The immutable fact that a Participant was originally copied from a particular Character. Provenance is traceability, not identity, ownership, or synchronization.
_Avoid_: Character link, live source, inheritance

**Writer**:
An ordinary possible Participant name with no special domain behavior.
_Avoid_: Writer role, Writer Control, Writer Message type

**Cast**:
The ordered set of active Participants in a Conversation.
_Avoid_: Roster, Character list, active/inactive group

**Control**:
The current assignment of one Cast Participant to the human seat and another distinct Cast Participant to the model seat. Control is neither identity nor authorship.
_Avoid_: Role, Author Stamp, Message intent

**Playable**:
The derived state in which both distinct Control seats are occupied by Cast Participants.
_Avoid_: Stored status, imported mode

**Incomplete Conversation**:
A preservation-oriented imported Conversation missing one or both Control seats. Its history remains a normal Chat, but play actions remain unavailable until the missing seat is filled.
_Avoid_: Broken Chat, imported-only Chat, draft Conversation

## Authorship and generation context

**Author Stamp**:
Immutable Message attribution containing the authoring Participant identity and the Participant name captured when the Message was created.
_Avoid_: Current Participant name, provider role, Character attribution

**Historical Control Context**:
The human/model Participant pair captured when native generation of a Message begins. It governs later sibling Variant generation for that Message and does not alter current Control.
_Avoid_: Current Control, Author Stamp, imported role inference

**Prompt Plan**:
The provider-neutral ordered blocks produced by compiling Participant Definitions and selected Conversation history for one Generation.
_Avoid_: Prompt, request body, Guidance Message

## Model connection

**Connection Preset**:
An app-owned factory of recommended connection defaults for a named model provider. Selecting a Preset creates an independently editable Connection Profile; Presets never appear as empty Profiles by themselves.
_Avoid_: Connection Profile, backend

**Connection Profile**:
A globally available saved model connection containing shared connection details, an API Format, secret references, a Model Backend preference, and any backend-specific options. When Profiles exist exactly one is active for new Generations; with none, model generation is unconfigured.
_Avoid_: Conversation settings, Provider, Preset

**API Format**:
The model request and streaming contract selected by a Connection Profile. Version one implements OpenAI Chat Completions; OpenAI Responses and Anthropic Messages are reserved but deferred. API Format is independent of the Model Backend and the request URL.
_Avoid_: Model Backend, Provider, endpoint

**Model Backend**:
The advanced selectable implementation that executes model requests for a Connection Profile. Automatic selects one compatible Backend before a request starts; it never changes Backend during that Generation.
_Avoid_: Model Provider, Connection Profile, transport

**AI SDK Adapter**:
The advanced, explicit selection of one provider-dialect adapter bundled inside the AI SDK Model Backend. A Connection Preset copies a concrete Adapter into a Profile; changing the Profile URL never changes it implicitly.
_Avoid_: Model Backend, Connection Preset, npm package name

**Connection Secret**:
A write-only authentication value owned by a Connection Profile, including credentials and configured header values. Clients may see its JSON key or configured state but never its stored value.
_Avoid_: API key when referring to all secret connection material

**Discovery Catalog**:
The persisted per-Profile cache of model IDs returned by the latest successful Models endpoint refresh. It supplies autocomplete but never restricts which model ID a Conversation may use.
_Avoid_: Supported-model allowlist, Pinned Models

**Pinned Models**:
The ordered model IDs starred on a Connection Profile and shown as its small default model-selection list. Selection never pins implicitly, and discovery refresh never rewrites the list.
_Avoid_: Discovery Catalog, provider-supported models

## Lifecycle

**Participant Tombstone**:
The stripped identity retained after a referenced Participant leaves the Cast, preserving stable identity, final name, Conversation membership, and Character Provenance without a Definition.
_Avoid_: Inactive Participant, archived Cast member, restorable Participant

**Character Tombstone**:
The hidden stripped identity retained after a referenced Character is deleted, preserving stable identity and final name while Participant provenance still requires it.
_Avoid_: Archived Character, disabled Character, restorable Character

## Import

**Chat Import**:
The operation that creates a normal Conversation from an external source while preserving source evidence. Import is an ingestion event, not a lasting Chat identity or capability mode.
_Avoid_: Imported Chat type, migration mode

**Staged Import**:
A temporary import flow that validates exact uploaded bytes and gathers user-confirmed Participant resolution before committing a Chat Import.
_Avoid_: Imported Conversation, durable import draft

**Staging Handle**:
An opaque temporary reference to one Staged Import.
_Avoid_: Chat identifier, artifact identifier

**Import Projection**:
The pure derivation that maps decoded import source into native Conversation creation data: resolved author ownership, stamped Messages, derived Control, and composed archive/report entries. Both import paths run one projection with different resolution inputs.
_Avoid_: Import mapping, import resolver

**Default Import Policy**:
The developer import's implicit author-resolution rules — trimmed-name grouping, the imported-author placeholder name, and deterministic Control — expressed as the Import Projection's resolution input.
_Avoid_: Developer grouping, legacy resolution

**Resolved Participant Plan**:
The user-confirmed author-resolution decision for one Staged Import: each resulting Participant's name, outcome, and owned Message positions. It is the staged path's resolution input to the Import Projection.
_Avoid_: Import plan, confirmed policy

**Exact Source Artifact**:
The preserved original import bytes and their verification metadata, distinct from the normal Conversation history and canonical parsed archive.
_Avoid_: Reconstructed export, Conversation history
