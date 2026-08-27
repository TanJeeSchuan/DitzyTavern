# 03 — Choose and preview a staged Chat import

**What to build:** Let a user begin Import Chat from the Chats panel, choose one local export, upload its contents once, and receive a trustworthy staged preview before any native or global domain record is created. The preview must make structural problems, duplicate evidence, source author groups, and name-only Character suggestions visible while preserving the user's in-progress work after recoverable errors.

**Blocked by:** 01 — Character System dependency gate; 02 — Preserve the exact original import artifact.

**Status:** resolved

- [x] Import Chat appears as a first-order action in the Chats primary panel and opens a nested panel flow with Back and Cancel controls.
- [x] The same nested flow uses the existing full-screen panel treatment at narrow widths rather than introducing a separate mobile workflow.
- [x] The picker prefers `.jsonl` but accepts any extension whose contents validate as SillyTavern JSONL.
- [x] The flow accepts exactly one file and imposes no application-level source-size limit.
- [x] Upload streams the selected bytes into managed temporary storage once; the client never sends a browser filesystem path and final commit does not reopen the original file.
- [x] A staged token binds the preview to the exact byte length and SHA-256 that were uploaded.
- [x] Validation completes before Participant resolution and reports malformed JSON, line-level errors, invalid UTF-8, and structural defects contextually.
- [x] A successful preview includes an editable filename-derived Chat title, original filename, SHA-256, declared integrity when present, Message and Variant counts, warnings, matching prior imports, and one initial group per resolved (trimmed) captured author string, with whitespace variants and blank names merged.
- [x] Preview classifies a matching SHA-256 as an exact duplicate and a declared-integrity-only match as a related source.
- [x] Existing Character suggestions use names only, ranked exact first, then case-insensitive, then fuzzy; SillyTavern roles, header fields, avatar data, Message content, and `is_user` do not influence the result.
- [x] The strongest Character suggestion may be pre-filled but remains visibly unconfirmed and cannot satisfy final review until the user approves it.
- [x] Blank captured names appear as explicit groups with an editable `Unknown imported author` Participant-name default.
- [x] Recoverable errors preserve the staged preview and choices made during the open flow when the source token and hash remain valid.
- [x] Cancel warns before discarding the open flow and removes only uncommitted temporary staging data.
- [x] A server restart expires the staged flow and requires file reselection; no durable import draft or resume system is introduced.
- [x] The deep SillyTavern Import module is the primary behavioral seam, with typed HTTP routes remaining thin and the UI using one replaceable import-client boundary.
- [x] Focused tests cover upload-once semantics, token/hash binding, preview fields, exact grouping, name-only ranking, unconfirmed pre-fill, duplicate classification, cancellation, expiry, and contextual validation failure.

## Comments

- This ticket intentionally stops at a complete, reviewable preview. It creates no native Chat and no Actor Profile.
