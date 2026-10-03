# Image store and Portraits

Status: TODO

Blocked By: None

Source: `docs/specs/image-handling.md`, User Stories 1–17, Implementation Decisions 1–5 and 16; ADR-0045, ADR-0046.

## Goal

Add the single content-addressed Image store, and give Definitions Portraits as its first consumer.

## Ownership

- `src/server/database/schema.ts` and a generated migration
- A new `src/server/image/` module and its read route under `src/server/contract/`
- `src/shared/definition.ts`, `src/server/character-library/`, and Participant seeding, Save as Character, and duplication in `src/server/conversation/`
- `src/client/characters/` and every identity display
- `package.json` (`@uwx/exif-be-gone-web`)

## Work

- [ ] Add the `image` table keyed by SHA-256 (bytes, media type, byte size, width, height). Add a reference index with cascading deletes from every owner kind: Variant, Character and Participant Prompt, Character and Participant Opening, Definition Portrait, Macro State value, and Active Generation record. Add a trigger that deletes an Image when its last reference row goes.
- [ ] Implement ingest. Accept PNG, JPEG, WebP, and GIF by magic bytes up to 20 MB, and reject anything else with a typed error. Strip metadata with `@uwx/exif-be-gone-web`, read dimensions from the header, then hash. Never resize, transcode, or decode.
- [ ] Expose one transaction-scoped operation that ingests inline payloads and re-syncs an owner's references. Serve Images by hash with permanent caching.
- [ ] Add the optional Portrait (hash and focal point) to Definitions, carried inline in Definition create and update. Copy it on seeding, Save as Character, and duplication. Drop it with a Participant Tombstone, and never capture it in Author Stamps or a Prompt Plan.
- [ ] Add Portrait upload and a focal point picker to the Character and Participant editors. Show Portraits in DESIGN.md squircle frames wherever identity is rendered, using the focal point as the object position and falling back to initials.
- [ ] Test spec Testing Decisions 2, 3, and 7 through the store and the existing Character Library and Conversation contracts. Verify Portrait UI manually with playwright-cli.
- [ ] Run focused tests, typechecking, and the full test suite.
- [ ] Run `/code-review` and resolve its findings.
- [ ] Set this ticket to DONE and commit the implementation.

## Acceptance

- Metadata is stripped with pixel data unchanged, GIF animation survives, and identical uploads produce one Image.
- An Image disappears in the transaction that removes its last reference. A failed command leaves neither an Image nor a reference.
- Changing a Character's Portrait never changes existing Chats.
