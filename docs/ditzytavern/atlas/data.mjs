// Single source of truth for the DitzyTavern system atlas.
// Build: node docs/ditzytavern/atlas/build.mjs

export const META = {
  title: 'DitzyTavern',
  artifactUrl: '',
  sourcePath: 'docs/ditzytavern/atlas/data.mjs',
  buildCmd: 'node docs/ditzytavern/atlas/build.mjs',
  stats: [
    { k: 'System', v: 'server authority · v1' },
    { k: 'Built seams', v: '10' },
    { k: 'Deferred edges', v: '5' },
  ],
  intro: `_**This file is the living source of truth for the architecture map.** The interactive atlas and the text twin are generated from the same data; edit this file, then rebuild both views._`,
  onePara: `DitzyTavern is a local, single-user, text-first cooperative writing workspace inspired by selected SillyTavern capabilities. The browser is a thin React SPA: it reads authoritative Conversation state, sends revisioned HTTP commands, and renders the active story. A deep Conversation module owns Cast, Control, Messages, Variants, authorship, SQLite transactions, and derived playability; a pure Prompt Compiler turns resolved Participants and selected history into a provider-neutral Prompt Plan. Native Chat creation and generation are composed through workflows, while the current SillyTavern import path stages exact uploaded bytes, lets the user resolve author groups, and graduates the result into an ordinary Conversation. The OpenAI-style Model Client and resumable SSE edge are settled architectural seams but are not yet switched on in the current source tree.`,
  costModel: [
    'No external service cost is modeled: version one is local and text-only.',
    'The remote model endpoint is user-configured; credentials remain server-owned application configuration and never enter Conversation state.',
  ],
  deepDive: '',
  platformGives: 'Bun, bun:sqlite, Drizzle ORM, Elysia, React, TypeScript, Vite, and the browser provide runtime, transport, rendering, and migration primitives.',
  weOwn: 'Conversation invariants, Character forks, prompt compilation, revision/conflict behavior, import preservation, artifact custody, generation coordination, and the user-facing resolution flow.',
  filesystem: `src/server/conversation/      deep Conversation seam\nsrc/server/character-library/ reusable Definitions\nsrc/server/workflows/         native Chat, generation, and Character composition\nsrc/server/prompt-compiler/   pure provider-neutral Prompt Plan\nsrc/server/sillytavern/       adapter, staging, preview, and atomic graduation\nsrc/server/artifact/          exact-file metadata and verified reads\nsrc/server/database/          SQLite, Drizzle schema, migrations\nsrc/shared/contract/          typed Elysia HTTP adapters\nsrc/client/                   React SPA and story workspace\ndocs/adr/                     architectural decisions\ndocs/ditzytavern/atlas/       this source plus generated views`,
};

export const DECISIONS = [
  { axis: 'Product boundary', decision: 'Clean-slate focused reimplementation; local, single-user, text-first, with one active human and model Control seat.', adr: '[0001](../adr/0001-focused-reimplementation.md)' },
  { axis: 'Authority', decision: 'The server owns Conversation state, prompt assembly, generation lifecycles, persistence, and coordination.', adr: '[0002](../adr/0002-server-authoritative-runtime.md)' },
  { axis: 'Commands and events', decision: 'Use revisioned HTTP commands plus resumable SSE; replay is bounded and snapshot fallback is authoritative.', adr: '[0004](../adr/0004-use-http-commands-and-resumable-sse.md)' },
  { axis: 'Runtime', decision: 'Use TypeScript and Elysia for the typed HTTP surface.', adr: '[0011](../adr/0011-use-typescript-and-elysia.md)' },
  { axis: 'Browser', decision: 'Serve a static React SPA; the browser owns presentation state, not domain authority.', adr: '[0012](../adr/0012-serve-a-client-rendered-static-spa.md)' },
  { axis: 'Conversation seam', decision: 'Keep a small deep Conversation interface over snapshots, commands, history, and generation commits.', adr: '[0013](../adr/0013-center-the-server-on-a-deep-conversation-module.md)' },
  { axis: 'Prompting', decision: 'Compile a deterministic provider-neutral Prompt Plan in a pure module.', adr: '[0014](../adr/0014-isolate-a-pure-prompt-compiler.md)' },
  { axis: 'Model edge', decision: 'Hide OpenAI-style streaming translation, credentials, cancellation, and errors behind one Model Client.', adr: '[0015](../adr/0015-hide-model-transport-in-one-deep-module.md)' },
  { axis: 'Identity', decision: 'Character, Conversation-local Participant, Control seat, and immutable Message authorship are separate concepts.', adr: '[0016](../adr/0016-separate-characters-participants-and-authorship.md)' },
  { axis: 'Reusable identities', decision: 'Character Library owns complete Definitions and revisioned lifecycle; adding a Character forks its Definition into the Cast.', adr: '[0017](../adr/0017-isolate-the-character-library.md)' },
  { axis: 'Variants', decision: 'Alternative model replies are sibling Variants at one Message position; selection is revisioned and non-destructive.', adr: '[0003](../adr/0003-model-alternative-replies-as-variants.md)' },
  { axis: 'Persistence', decision: 'Drizzle is the typed query layer over bun:sqlite; domain modules still own their tables and invariants.', adr: '[0024](../adr/0024-adopt-drizzle-orm-and-drizzle-kit.md)' },
  { axis: 'Settings', decision: 'Global connection settings are separate from Conversation-owned generation settings and are applied atomically.', adr: '[0019](../adr/0019-split-connection-and-generation-settings.md), [0023](../adr/0023-apply-configuration-edits-atomically.md)' },
  { axis: 'Secrets', decision: 'Credentials stay in server-owned application configuration and never enter SQLite, snapshots, prompts, events, or logs.', adr: '[0022](../adr/0022-keep-connection-secrets-outside-conversation-state.md)' },
];

export const GROUPS = [
  { id: 'loop', title: 'The main loop' },
  { id: 'mem', title: 'Authoritative state' },
  { id: 'sup', title: 'Supporting seams' },
  { id: 'off', title: 'Designed for, not switched on' },
];

// Structure fields: id/code, name, short, group, gx/gy/w/d/h, kind, ghost,
// one, what, how, steps, and cond. See the System Atlas skill for the shape
// grammar and question-state format.
export const NODES = [
  {
    id: 'UI', code: 'UI', name: 'React writing workspace', short: 'REACT SPA', group: 'loop', gx: 0, gy: 5, w: 2.4, d: 2.2, h: 34, kind: 'screen',
    one: 'The browser renders the active Chat and collects explicit user intent.',
    what: 'DitzyTavern opens on the active Conversation. The story surface, Cast controls, composer, Swipe actions, import panels, and settings are presentation over server-owned state.',
    how: 'The static React/Vite client is rooted at <code>src/client/App.tsx</code>. <code>ActiveWritingWorkspace</code> loads snapshots and paged history, keeps drafts locally, and applies authoritative results after typed API outcomes.',
    steps: [['Open', 'Load the workspace and active Chat.'], ['Read', 'Fetch the latest history page and preserve scroll anchoring.'], ['Act', 'Send a revisioned command or start a staged flow.'], ['Render', 'Apply the returned Conversation summary without inventing domain state.']],
    cond: [
      { q: 'How will the current SPA receive live token and lifecycle events when the planned event edge is implemented?', to: 'SSE route implementation' },
      { q: 'Which prompt-inspection editing affordances belong in the right-side details surface?', to: 'Prompt inspection UX pass' },
    ],
  },
  {
    id: 'API', code: 'API', name: 'Typed Elysia contract', short: 'HTTP API', group: 'loop', gx: 3.5, gy: 5, w: 2.2, d: 2.2, h: 42, kind: 'gate',
    one: 'Thin routes translate HTTP into public domain seams and typed outcomes.',
    what: 'The API gives the browser stable reads, revisioned commands, history pages, native Chat creation, Character Library operations, and staged import endpoints. It should not coordinate tables or duplicate rules.',
    how: '<code>src/shared/contract.ts</code> composes typed Elysia route modules. Conversation routes call <code>createConversationModule</code>; import routes preserve the raw request stream for staging; conflict and not-playable results are mapped to explicit transport outcomes.',
    steps: [['Decode', 'Validate path, query, and body shapes at the boundary.'], ['Delegate', 'Call one deep module or a named workflow.'], ['Map', 'Turn typed errors into 404, 409, or 422 outcomes.'], ['Return', 'Send an authoritative summary or staged preview.']],
    cond: [
      { q: 'Should client-facing error reasons become stable machine codes before the API is expanded?', r: 'Current routes expose typed outcome discriminants plus contextual reason strings; revisit when a second external client exists (2026-08-24).' },
    ],
  },
  {
    id: 'CONV', code: 'CV', name: 'Conversation module', short: 'CONVERSATION', group: 'loop', gx: 7, gy: 3.2, w: 3.2, d: 3.1, h: 72, kind: 'tall',
    one: 'The deep seam that owns Cast, Control, history, Messages, Variants, and Conversation invariants.',
    what: 'Conversation is the center of the server. It exposes a deliberately small interface while hiding revisions, Participants, active Control seats, immutable Author Stamps, selected Variants, data scopes, transactions, and derived playability.',
    how: '<code>src/server/conversation/index.ts</code> exposes snapshot reads, paged history, revisioned command execution, and server-side generation commits. The implementation spans <code>create.ts</code>, <code>execute.ts</code>, <code>snapshot.ts</code>, <code>history.ts</code>, and command modules.',
    steps: [['Capture', 'Read one authoritative snapshot and its current revision.'], ['Validate', 'Check Control, Participant, Message, Variant, and stale-revision rules.'], ['Mutate', 'Apply one command in a SQLite transaction.'], ['Publish', 'Return the updated snapshot or a typed conflict.']],
    cond: [
      { q: 'Where should active Generation lifecycle coordination sit once streaming transport is real?', to: 'Generation lifecycle deep dive' },
      { q: 'Should one Conversation module continue to own both history paging and generation coordination as concurrency grows?', r: 'Keep the public seam small and unified; split internal table/domain work only when a demonstrated pressure point appears (2026-08-24).' },
    ],
  },
  {
    id: 'PROMPT', code: 'PC', name: 'Prompt Compiler', short: 'PROMPT PLAN', group: 'loop', gx: 11.5, gy: 2.2, w: 2.7, d: 2.5, h: 36, kind: 'slab',
    one: 'A pure compiler turns resolved identities and selected history into a provider-neutral Prompt Plan.',
    what: 'Prompt assembly is deterministic and inspectable. It knows named block order, Participant role mapping, Example Dialogue, selected history, macros, warnings, and local budget behavior without knowing SQLite, HTTP, credentials, or a model vendor.',
    how: '<code>src/server/prompt-compiler/compiler.ts</code> implements <code>compilePrompt</code>, <code>compileOpening</code>, and one-pass <code>{{self}}</code>/<code>{{other}}</code> expansion. The result is consumed by workflows and can be shown through prompt inspection.',
    steps: [['Resolve', 'Use the current human/model Participants and selected history.'], ['Order', 'Emit system instruction, identities, scenario, examples, history, and post-history instruction.'], ['Budget', 'Reserve response budget and trim lower-priority context when configured.'], ['Inspect', 'Return named blocks, warnings, estimates, and omitted context.']],
    cond: [
      'What evidence should eventually replace the bundled tokenizer estimate for arbitrary model identifiers?',
      { q: 'When should a provider-neutral Prompt Plan become a persisted audit record?', to: 'Prompt inspection UX pass' },
    ],
  },
  {
    id: 'TRANSPORT', code: 'MC', name: 'Model Client', short: 'MODEL CLIENT', group: 'loop', gx: 15.3, gy: 2, w: 2.6, d: 2.5, h: 46, kind: 'tall', ghost: true,
    one: 'Planned boundary for translating a Prompt Plan into one OpenAI-style streaming request.',
    what: 'The ADR is settled, but the current tree injects a <code>generate(plan)</code> function into workflows instead of shipping a concrete transport module. The future seam will own credentials, request translation, streaming parsing, cancellation, timeout, normalized events, and provider errors.',
    how: 'Designed in ADR-0015; no <code>src/server/model-client/</code> implementation is currently present. It must accept a provider-neutral Plan, force one Variant, preserve reasoning separately, and never retry an ambiguous request automatically.',
    steps: [['Translate', 'Map named Prompt Plan blocks to the configured protocol.'], ['Stream', 'Normalize visible content, reasoning, usage, finish, and keepalive events.'], ['Cancel', 'Stop only the targeted Generation on user or timeout cancellation.'], ['Report', 'Return normalized terminal outcome and optional usage.']],
    cond: [
      'Which concrete OpenAI-style streaming adapter should be implemented first?',
      { q: 'Where should connection configuration live while remaining outside Conversations?', to: 'Connection settings implementation' },
    ],
  },
  {
    id: 'SSE', code: 'EV', name: 'Resumable live events', short: 'LIVE EVENTS', group: 'off', gx: 15.2, gy: 6.6, w: 2.2, d: 2.1, h: 28, kind: 'gate', ghost: true,
    one: 'Planned event edge for streaming Generation output and synchronizing multiple views.',
    what: 'The architecture reserves resumable Server-Sent Events for ordered Conversation and Generation updates. The current server has the HTTP and SPA pieces but no <code>/events</code> implementation, so this remains visibly deferred.',
    how: 'ADR-0004 specifies ordered event IDs, bounded replay, last-event resumption, and fresh snapshot fallback after a miss or restart. The event buffer is not a permanent domain-event log.',
    steps: [['Subscribe', 'Open a Conversation-scoped event stream.'], ['Replay', 'Use the last received event ID when the bounded buffer can satisfy it.'], ['Fallback', 'Return a fresh authoritative snapshot when replay is unavailable.'], ['Stream', 'Deliver lifecycle and token updates without advancing revision for transient text.']],
    cond: [
      { q: 'Should the replay buffer remain process-local or move to a shared deployment store?', r: 'Keep it bounded and non-authoritative; snapshot fallback after restart avoids introducing a durable event log in version one (2026-08-24).' },
    ],
  },
  {
    id: 'DB', code: 'DB', name: 'SQLite and Drizzle state', short: 'SQLITE STATE', group: 'mem', gx: 7.3, gy: 8.8, w: 3.1, d: 3, h: 36, kind: 'store',
    one: 'The local database stores authoritative entities, revisions, history, copied Definitions, and metadata.',
    what: 'SQLite is the durable source of truth for Chats, Messages, Variants, Participants, Control assignments, Characters, generic data scopes, and artifact metadata. A small Database module opens it, applies migrations, and configures WAL/foreign keys.',
    how: '<code>src/server/database/database.ts</code> opens <code>bun:sqlite</code> and runs Drizzle migrations. <code>src/server/database/schema.ts</code> defines the tables; domain modules use Drizzle directly instead of a generic repository layer.',
    steps: [['Open', 'Create the local file or in-memory test database.'], ['Prepare', 'Enable foreign keys, WAL, busy timeout, and migrations.'], ['Transact', 'Let the owning module commit a complete domain mutation.'], ['Read', 'Build snapshots and paged history from current rows.']],
    cond: [
      { q: 'Do Connection Settings and Generation Settings need dedicated tables beyond current domain data scopes?', to: 'Connection settings implementation' },
      { q: 'How should cleanup of committed artifact files be reconciled with database deletion?', r: 'Database deletion removes metadata only; physical copies remain for manual recovery and are not automatically garbage-collected (2026-08-24).' },
    ],
  },
  {
    id: 'HISTORY', code: 'HI', name: 'History read seam', short: 'HISTORY PAGES', group: 'mem', gx: 11.7, gy: 8.8, w: 2.7, d: 2.6, h: 26, kind: 'screen',
    one: 'Paged history keeps ordinary story reading light while preserving stable chronology.',
    what: 'The active story loads the newest window first and asks for older pages on demand. Variant bodies and immutable author identity are enough for reading; heavy provenance stays behind deliberate detail surfaces.',
    how: '<code>ConversationModule.readHistory</code> delegates to <code>src/server/conversation/history.ts</code>. The React workspace prepends older pages with scroll anchoring, and selection remains a revisioned Conversation command.',
    steps: [['Page', 'Request a bounded page counted backward from the newest Message.'], ['Project', 'Return active Cast identity and lightweight Variants.'], ['Prepend', 'Add older Messages without moving the reading viewport.'], ['Select', 'Persist Swipe selection through the Conversation revision.']],
    cond: [
      { q: 'Should heavy provenance and prompt details remain separate from the normal history payload?', r: 'Yes. Ordinary reads stay lightweight; deliberate detail operations load exact artifacts, reasoning, signatures, or prompt inspection only when requested (2026-08-24).' },
    ],
  },
  {
    id: 'CHAR', code: 'CH', name: 'Character Library', short: 'CHAR LIBRARY', group: 'sup', gx: 2.4, gy: 10.4, w: 3, d: 3, h: 38, kind: 'store',
    one: 'Reusable Characters own complete Definitions that can seed independent Cast Participants.',
    what: 'The library is optional convenience, not the identity model. It lists, reads, edits, pins, and deletes reusable Definitions with revisions. Adding one to a Chat copies its name, prompt, and openings into a new Conversation-local Participant.',
    how: '<code>src/server/character-library/</code> exposes a small revisioned module. Character edits never synchronize into existing Participants; referenced deletion creates a hidden tombstone so provenance remains meaningful.',
    steps: [['List', 'Order active Characters by pin, name, and stable identifier.'], ['Edit', 'Replace the complete prompt or ordered openings under expected revision.'], ['Fork', 'Copy a Definition into a new Cast Participant.'], ['Retain', 'Keep provenance even when the source Character is later tombstoned.']],
    cond: [
      'When should duplicate Character names require a stronger user-facing disambiguator than computed ordinal labels?',
      { q: 'Should Character provenance ever become an identity or synchronization key?', r: 'No. Provenance is informational; selecting a Cast identity and adding from the Library remain distinct operations (2026-08-24).' },
    ],
  },
  {
    id: 'WF', code: 'WF', name: 'Composition workflows', short: 'WORKFLOWS', group: 'sup', gx: 5.5, gy: 12.1, w: 2.7, d: 2.6, h: 32, kind: 'cards',
    one: 'Workflows compose deep seams for native Chat creation, generation, and Character-to-Cast actions.',
    what: 'Workflows own cross-module use cases without becoming alternate domain stores. They resolve Character revisions, build Conversation creation input, derive Prompt Plans, inject transport behavior, and commit completed Messages or sibling Variants.',
    how: '<code>src/server/workflows/</code> contains <code>native-chat.ts</code>, <code>generate.ts</code>, <code>add-character-to-cast.ts</code>, and save-back workflows. The public routes call these compositions, while tests can inject deterministic generation functions.',
    steps: [['Compose', 'Resolve each use case across its public module interfaces.'], ['Capture', 'Snapshot active Control, author name, and historical context at generation start.'], ['Delegate', 'Call the pure compiler or injected model function.'], ['Commit', 'Return to Conversation for one authoritative persistence mutation.']],
    cond: [
      { q: 'Should workflow APIs expose a first-class Generation object once streaming exists?', to: 'Generation lifecycle deep dive' },
      { q: 'Where should prompt edits for one Generation be validated?', r: 'Keep the one-shot edited Prompt Plan inside the Generation workflow; do not mutate Participant Prompts or Conversation history (2026-08-24).' },
    ],
  },
  {
    id: 'IMPORT', code: 'IM', name: 'Staged Chat import', short: 'IMPORT STAGING', group: 'sup', gx: 10.1, gy: 13, w: 2.8, d: 2.7, h: 42, kind: 'gate',
    one: 'A preservation-first flow validates, resolves, reviews, and graduates an export into a normal Chat.',
    what: 'The import path never fabricates identity silently and never commits a partial interpretation. It streams the uploaded JSONL once, binds a session token to exact bytes, groups source authors without merging them, proposes name-only Character matches, and waits for explicit user resolution.',
    how: '<code>src/server/sillytavern/staged.ts</code> owns the staged registry and commit boundary; <code>staged/preview.ts</code> builds the preview. The commit uses public Character and Conversation seams, preserves every Message and Variant, and stores a canonical report plus exact source artifact.',
    steps: [['Stage', 'Stream bytes to temporary storage while hashing them.'], ['Inspect', 'Validate JSONL and report counts, warnings, author groups, and duplicate evidence.'], ['Resolve', 'Let the user split, merge, rename, fork, or keep Chat-only Participants.'], ['Graduate', 'Atomically create a normal Conversation with preserved history and custody metadata.']],
    cond: [
      { q: 'How should a one-author or zero-author import surface its missing Control seat?', r: 'Commit as an incomplete native Conversation, keep history readable and editable, and withhold Compose, Generate, and Swipe until a second distinct Participant is added (2026-08-24).' },
      { q: 'Should related-source matches block import the way exact raw-byte duplicates do?', r: 'No. Exact SHA-256 matches require explicit Import another copy confirmation; declared-integrity-only related matches remain advisory (2026-08-24).' },
    ],
  },
  {
    id: 'ART', code: 'AR', name: 'Exact artifact custody', short: 'ARTIFACT STORE', group: 'sup', gx: 14.1, gy: 12.2, w: 3, d: 3, h: 30, kind: 'store',
    one: 'Managed files preserve original bytes beside verifiable metadata without making files the domain authority.',
    what: 'Imports keep an exact source copy under a managed relative path. SQLite stores filename, media type, byte length, and SHA-256; reads and downloads verify those values and report missing or corrupt files as cleaned-up provenance rather than corrupting the Chat.',
    how: '<code>src/server/artifact/</code> owns metadata lookup, byte verification, download disposition, and managed paths. The Conversation creation seam inserts artifact metadata atomically; physical copies are deliberately not deleted by Chat deletion.',
    steps: [['Finalize', 'Move the verified staged file to a unique managed path.'], ['Record', 'Commit metadata with the Conversation and import report.'], ['Verify', 'Compare stored bytes to recorded length and SHA-256 on inspection.'], ['Download', 'Return exact bytes with a sanitized presentation filename.']],
    cond: [
      { q: 'When should orphaned managed files be reclaimed?', r: 'Not automatically in version one; leaving exact copies recoverable is preferred over a risky cleanup job (2026-08-24).' },
    ],
  },
  {
    id: 'LORE', code: 'WI', name: 'World Info blocks', short: 'WORLD INFO', group: 'off', gx: 1, gy: 15.4, w: 2.2, d: 2.2, h: 32, kind: 'cards', ghost: true,
    one: 'Deferred named-block context for lorebook and World Info behavior.',
    what: 'Version one intentionally compiles only active Participant prompt channels, Example Dialogue, and selected Conversation history. A future named-block prompt system may add World Info without smuggling a lorebook scanner into the current loop.',
    how: 'ADR-0001 explicitly excludes World Info and lorebook scanning. The future seam must feed the Prompt Compiler rather than bypassing it.',
    steps: [['Define', 'Specify named blocks and their precedence.'], ['Select', 'Determine which entries apply to a Conversation turn.'], ['Compile', 'Hand resolved content to the Prompt Compiler.']],
    cond: ['What named-block API and selection trigger should future World Info use?'],
  },
  {
    id: 'EXT', code: 'EX', name: 'Extension runtime', short: 'EXTENSIONS', group: 'off', gx: 4.5, gy: 16.1, w: 2.5, d: 2.3, h: 25, kind: 'cards', ghost: true,
    one: 'A future extension surface is deliberately absent until a demonstrated use case earns it.',
    what: 'DitzyTavern is not preserving SillyTavern plugin compatibility. Version one supports explicit core Conversation commands and keeps the main loop understandable.',
    how: 'ADR-0001 excludes a user-installable extension or plugin runtime. Any future capability must earn a seam from concrete use rather than a generic hook lattice.',
    steps: [['Observe', 'Identify a repeated need in the supported flow.'], ['Constrain', 'Define a narrow capability and trust boundary.'], ['Expose', 'Add one explicit seam with tests and ownership.']],
    cond: [{ q: 'What real use case would justify an extension runtime?', r: 'No runtime in version one; revisit only from demonstrated product use, not compatibility pressure (2026-08-24).' }],
  },
  {
    id: 'MEDIA', code: 'MD', name: 'Media and tool pipeline', short: 'MEDIA / TOOLS', group: 'off', gx: 8.5, gy: 17, w: 3, d: 3, h: 25, kind: 'slab', ghost: true,
    one: 'Attachments, multimodal input, image generation, speech, and model tools are separate future pipelines.',
    what: 'Version one is text-only. Adding media or tools would change storage, provider translation, prompt representation, rendering, and security boundaries, so they remain a ghost rather than an implied feature of the current Model Client.',
    how: 'ADR-0001 excludes attachments, multimodal Messages, image generation, speech input/output, and model tool calls. Each future capability should first establish its own artifact, transport, and UI contracts.',
    steps: [['Model', 'Define the new content and security contract.'], ['Store', 'Choose custody and lifecycle for non-text data.'], ['Translate', 'Add provider-neutral representation before vendor mapping.']],
    cond: ['Which media or tool use case is concrete enough to split into a separate pipeline?'],
  },
  {
    id: 'DRAFT', code: 'DR', name: 'Durable import drafts', short: 'DURABLE DRAFTS', group: 'off', gx: 13.2, gy: 16.7, w: 2.7, d: 2.5, h: 28, kind: 'store', ghost: true,
    one: 'A durable resume system for staged imports is intentionally not part of version one.',
    what: 'Staged handles are process-local and session-bound. A server restart expires the flow and asks the user to select the file again; committed files are not removed by that expiry.',
    how: '<code>staged.ts</code> keeps handles in an in-memory registry and retains consumed results for idempotent retries. No durable import draft table or cleanup journal exists.',
    steps: [['Hold', 'Keep one uploaded source and preview in temporary storage.'], ['Expire', 'Let restart or discard remove the active handle.'], ['Retry', 'Require file reselection after process loss.']],
    cond: [{ q: 'When does import volume or interrupted review make durable drafts worth the complexity?', r: 'Not yet; session-bound staging keeps the preservation path narrow and recoverable (2026-08-24).' }],
  },
];

// Final-chapter flows. Payloads are representative shapes derived from the
// current seams, not measured network traffic.
export const FLOWS = [
  { id: 'reply', name: 'Native reply', hops: [
    ['UI', 'API', 'send command', { expectedRevision: 7, action: 'create-message' }, 'yx'],
    ['API', 'CONV', 'revisioned command', { action: 'create-message', revision: 7 }, 'xy'],
    ['CONV', 'PROMPT', 'selected history', { human: 'Writer', model: 'Character', messages: 12 }, 'yx'],
    ['PROMPT', 'TRANSPORT', 'Prompt Plan', { blocks: 8, budget: 'estimated' }, 'xy'],
    ['TRANSPORT', 'CONV', 'normalized completion', { contentDelta: 'The room went quiet…', finish: 'stop' }, 'yx'],
    ['CONV', 'DB', 'atomic commit', { message: 14, variants: 1, revision: 8 }, 'xy'],
    ['DB', 'UI', 'authoritative update', { selectedVariant: 31, status: 'applied' }, 'yx'],
  ] },
  { id: 'new', name: 'Create a Chat', hops: [
    ['UI', 'API', 'new Chat request', { name: 'A quiet morning' }, 'yx'],
    ['API', 'WF', 'native workflow', { humanSeat: 'adhoc', modelSeat: 'character#4' }, 'xy'],
    ['WF', 'CHAR', 'read Character', { characterId: 4, expectedRevision: 2 }, 'yx'],
    ['WF', 'CONV', 'complete creation input', { participants: 2, control: ['human', 'model'] }, 'xy'],
    ['CONV', 'DB', 'create transaction', { chat: 9, roster: 2, openings: 1 }, 'yx'],
    ['DB', 'UI', 'new active Chat', { conversationId: 9, playable: true }, 'xy'],
  ] },
  { id: 'history', name: 'Read older history', hops: [
    ['UI', 'API', 'older page', { conversationId: 9, page: 2, pageSize: 20 }, 'yx'],
    ['API', 'HISTORY', 'history read', { page: 2, pageSize: 20 }, 'xy'],
    ['HISTORY', 'DB', 'position window', { from: 1, to: 20, order: 'chronological' }, 'yx'],
    ['DB', 'HISTORY', 'lightweight Messages', { messages: 20, variants: 'selected + siblings' }, 'xy'],
    ['HISTORY', 'UI', 'prepend and anchor', { hasOlder: false, scroll: 'stable' }, 'yx'],
  ] },
  { id: 'import', name: 'Graduate an import', hops: [
    ['UI', 'API', 'stream upload', { filename: 'chat.jsonl', bytes: 'ReadableStream' }, 'yx'],
    ['API', 'IMPORT', 'stage and hash', { sha256: 'raw-byte digest', token: 'session-bound' }, 'xy'],
    ['IMPORT', 'ART', 'finalize exact source', { mediaType: 'application/jsonl', verified: true }, 'yx'],
    ['IMPORT', 'CHAR', 'name-only suggestion', { key: 'Mira', match: 'case-insensitive', confirmed: false }, 'xy'],
    ['IMPORT', 'CONV', 'atomic graduation', { messages: 42, participants: 3, playability: 'derived' }, 'yx'],
    ['CONV', 'DB', 'history + report + metadata', { archive: 'canonical', source: 'exact copy' }, 'xy'],
    ['DB', 'UI', 'ordinary Chat receipt', { conversationId: 12, opensImmediately: true }, 'yx'],
  ] },
];

// Each chapter adds no more than three structures. The last chapter reveals
// the full map and exposes the final flow picker.
export const CH = [
  { id: 'surface', title: 'You and the writing surface', reveal: ['UI', 'API'],
    lede: 'Start with the only thing a user needs to feel: the story surface answers to explicit intent.',
    story: `<p>The browser opens on the active Chat, reads the latest story window, and keeps drafts close to the user. A command crosses the <mark>typed API boundary</mark>; the browser does not become a second domain model.</p>`,
    flow: [['UI', 'API', 'user intent', { action: 'send', expectedRevision: 7 }, 'yx'], ['API', 'UI', 'typed outcome', { outcome: 'accepted', revision: 8 }, 'xy']] },
  { id: 'center', title: 'The Conversation center', reveal: ['CONV'],
    lede: 'One deep module owns the Chat shape that every surface depends on.',
    story: `<p>Conversation is where Cast, Control, Messages, Variants, authorship, and revision rules meet. Routes and workflows use the seam; they do not coordinate the tables behind it.</p>`,
    flow: [['API', 'CONV', 'revisioned command', { action: 'create-message', revision: 7 }, 'yx'], ['CONV', 'API', 'snapshot or conflict', { revision: 8, outcome: 'applied' }, 'xy']] },
  { id: 'state', title: 'Durable local state', reveal: ['DB'],
    lede: 'The center is durable because SQLite is authoritative, local, and transaction-backed.',
    story: `<p>Drizzle gives domain code a typed query layer over <code>bun:sqlite</code>. The database stores both the current Conversation and the copied identity Definitions that make old history understandable.</p>`,
    flow: [['CONV', 'DB', 'atomic mutation', { tables: ['chat', 'messages', 'message_variant'], revision: 8 }, 'yx'], ['DB', 'CONV', 'committed rows', { selectedVariant: 31, revision: 8 }, 'xy']] },
  { id: 'prompt', title: 'Assembling the next turn', reveal: ['PROMPT'],
    lede: 'Before any provider sees a request, the server builds a named, inspectable Prompt Plan.',
    story: `<p>The compiler knows active Participants, selected history, typed prompt channels, examples, macros, and budget rules. It deliberately does not know credentials or vendor JSON, keeping prompting testable and explainable.</p>`,
    flow: [['CONV', 'PROMPT', 'generation context', { human: 'Writer', model: 'Mira', history: 12 }, 'yx'], ['PROMPT', 'CONV', 'provider-neutral plan', { blocks: 8, warnings: 0 }, 'xy']] },
  { id: 'generate', title: 'Composing generation', reveal: ['WF', 'TRANSPORT'],
    lede: 'Workflows compose the deep seams today; the concrete Model Client is the next edge to switch on.',
    story: `<p>The current <code>generate(plan)</code> injection keeps tests deterministic while the transport boundary remains honest. When implemented, the Model Client will translate the Plan, normalize stream events, and hand the finished result back for one Conversation commit.</p>`,
    flow: [['CONV', 'WF', 'generation workflow', { conversationId: 9, target: 'tail' }, 'yx'], ['WF', 'PROMPT', 'compile current turn', { selectedHistory: 12 }, 'xy'], ['PROMPT', 'TRANSPORT', 'planned provider call', { stream: true, n: 1 }, 'yx'], ['TRANSPORT', 'CONV', 'planned normalized reply', { finish: 'stop' }, 'xy']] },
  { id: 'read', title: 'Reading and swiping', reveal: ['HISTORY'],
    lede: 'The story stays light to read while Variants remain explicit, selectable, and non-destructive.',
    story: `<p>History pages return the selected Variant plus enough author identity to render the story. A Swipe changes selection through the Conversation revision; a new sibling uses captured historical Control rather than silently borrowing current seats.</p>`,
    flow: [['UI', 'HISTORY', 'request older page', { page: 2, pageSize: 20 }, 'yx'], ['HISTORY', 'DB', 'stable position window', { order: 'chronological' }, 'xy'], ['DB', 'UI', 'render selected Swipes', { variants: 4, selected: 2 }, 'yx']] },
  { id: 'identities', title: 'Characters become Participants', reveal: ['CHAR'],
    lede: 'Reusable Characters seed independent Conversation-local identities; they never become hidden live links.',
    story: `<p>The Character Library owns complete reusable Definitions. Native Chat creation and add-to-Cast workflows copy those Definitions, while the Conversation keeps its own Participant edits, control assignments, and historical author stamps.</p>`,
    flow: [['UI', 'CHAR', 'choose Character', { characterId: 4, revision: 2 }, 'yx'], ['CHAR', 'WF', 'fork Definition', { name: 'Mira', openings: 1 }, 'xy'], ['WF', 'CONV', 'add Participant', { position: 3, sourceCharacterId: 4 }, 'yx']] },
  { id: 'custody', title: 'Keeping imports honest', reveal: ['IMPORT', 'ART'],
    lede: 'Imports preserve custody first, then ask the user to resolve identity before they become playable.',
    story: `<p>The staged flow hashes the exact upload, previews every author group and Variant count, and makes the strongest Character suggestion a prefill rather than a decision. Commit graduates the source into an ordinary Conversation, even when the result is intentionally incomplete.</p>`,
    flow: [['UI', 'IMPORT', 'upload JSONL', { filename: 'chat.jsonl', bytes: 18420 }, 'yx'], ['IMPORT', 'ART', 'verified exact copy', { sha256: 'bound to preview' }, 'xy'], ['IMPORT', 'CONV', 'user-confirmed resolution', { groups: 3, messages: 42 }, 'yx']] },
  { id: 'later', title: 'Edges we have deliberately deferred', reveal: ['SSE', 'LORE', 'EXT'],
    lede: 'Several future capabilities have named seams, but none should blur the current product boundary.',
    story: `<p>Resumable events, World Info, and an extension runtime are architectural possibilities, not hidden implementation debt. The map keeps them visible as <mark>ghost structures</mark> so future work can attach to the current seams without rewriting the story.</p>`,
    flow: [['CONV', 'SSE', 'planned event stream', { eventId: 102, replay: 'bounded' }, 'yx'], ['LORE', 'PROMPT', 'future named block', { enabled: false }, 'xy'], ['EXT', 'API', 'future explicit capability', { enabled: false }, 'yx']] },
  { id: 'all', title: 'The whole DitzyTavern system', reveal: [],
    lede: 'Everything at once, for tracing one reply, creating a Chat, reading history, or graduating an import.',
    story: `<p>Choose a flow from the bottom-left picker. Hover to read, click to pin, use <code>→</code> to go inside a structure, and click a moving packet to inspect its representative payload. The <mark>Open questions</mark> tab is the discussion index.</p>`,
    flow: null },
];

export const HOW_HTML = `<div class="eyebrow">DitzyTavern · source-grounded atlas</div><h1 class="t">How it is built</h1><div class="sub">one source, two views, explicit seams</div>
<p class="lede">The atlas follows the repository's ADR vocabulary and current module boundaries. “Built” means there is a current source seam; a dashed structure is a settled design edge that the source tree has not switched on yet.</p>
<h3 class="sec">Filesystem</h3><pre>src/server/conversation/      deep Conversation seam
src/server/character-library/ reusable Definitions
src/server/workflows/         cross-module use cases
src/server/prompt-compiler/   pure Prompt Plan
src/server/sillytavern/       staged import and adapter
src/server/artifact/          exact file custody
src/server/database/          SQLite and Drizzle
src/shared/contract/          typed Elysia routes
src/client/                   React workspace
docs/adr/                     hard-to-reverse decisions</pre>
<h3 class="sec">Working rule</h3><p>Edit <code>atlas/data.mjs</code> only. Run <code>node docs/ditzytavern/atlas/build.mjs</code>; review the generated <code>SYSTEM.md</code> and serve the folder before publishing.</p>`;
