# 02 — Import a payload-only SillyTavern Chat end to end

**What to build:** Add the smallest complete developer import path through a separate SillyTavern JSONL adapter and the generic Conversation creation capability. A developer can give the database command a UTF-8 JSONL file containing payload-only Messages and receive a native Chat whose name comes from the filename, whose Messages each own one selected Variant, and whose complete parsed source and import report remain stored with the Conversation.

**Blocked by:** 01 — Create complete Conversations with Variant timestamps.

**Status:** resolved

- [x] A thin database command accepts a positional JSONL path and imports through the Conversation-owned creation seam.
- [x] The format adapter remains separate from generic Conversation creation and reads the source explicitly as UTF-8.
- [x] The first nonempty record becomes the source header and each later payload-only record becomes one Message with one selected Variant.
- [x] Message and Variant content, timestamps, ordering, and captured author names are preserved without deriving user, assistant, or system roles.
- [x] The imported Chat uses the filename stem as its temporary name, starts with no Character memberships, and has revision `0`.
- [x] One canonical `{ header, messages }` archive is serialized into Conversation-scoped text data, while source identity, counts, warnings, importer version, and the JSON report remain separate entries in the transitional import namespace.
- [x] The whole import is atomic and a focused synthetic-input test verifies the command's externally visible result without tracking private sample data.

## Comments

- New `src/server/sillytavern/` module: a pure JSONL→creation-input adapter (`adapter.ts`, no SillyTavern vocabulary in the Conversation module), orchestration (`import.ts`: explicit UTF-8 read with fatal decoder, SHA-256, prior-import detection, single-transaction creation), and errors (`SillyTavernImportError`).
- New `bun run db:import <path>` command (`src/server/database/import-chat.ts`) alongside seed/teardown.
- Canonical `{ header, messages }` archive stored as conversation-scoped `archive/source` text; source integrity, SHA-256, filename, importer version `0.1.0`, counts, warnings, and the JSON report stored separately under the transitional `import.sillytavern` namespace. Captured author names (including a preserved blank one) live on Messages as `import.sillytavern/author.name`; no roles are derived.
- Records with Swipes are accepted in this ticket and preserved value-losslessly in the archive; their alternative Variant projection and provenance promotion are ticket 03.
- 20 focused synthetic tests (adapter + end-to-end command seam) cover payload mapping, blank-name warnings, archive and report fidelity, filename-stem naming, revision 0, no memberships, duplicate imports, invalid UTF-8/JSON/timestamps/name/mes aborts, and atomic rollback. Lint, typecheck, full suite (31), migration check, build, and FK check clean; full 23.3 MB rescue export imports successfully as 833 Messages.
