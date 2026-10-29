# Row References in Box schemas

Status: TODO

Blocked By: None

Source: `docs/specs/chat-forking.md`, User Stories 9, 11; Implementation Decisions 3–4; ADR-0052.

## Goal

Every row id a Box stores is declared through a box-sdk id schema, every Chat and Participant value key has a declared schema, and one host function rewrites a Box value's Row References through an id map.

## Ownership

- `src/box-sdk/shared.ts`, `src/shared/contract/box-descriptor.ts` and the descriptor schema check
- `src/server/box` (the rewrite walker)
- Memory and Race contracts and descriptors
- `docs/box-system/README.md`

## Work

- [ ] Add `MessageId`, `VariantId`, `ParticipantId` (integer) and `ParticipantKey` (digit string, for `Type.Record` keys) to the box-sdk, each carrying a Row Reference annotation.
- [ ] Add a descriptor key declaring a schema for each Chat value key and each Participant value key. The loader refuses a descriptor whose value schema isn't a TypeBox schema; `put-box-data` and `putChatValue` refuse an undeclared key.
- [ ] Bump `boxSdkVersion`. No compatibility path.
- [ ] Write `rewriteRowReferences(schema, value, idMaps, { keepMissing })` covering Object, Array, Record (keys and values), Optional and Union, with Union picking its branch by `Value.Check`. A missing id throws an error carrying the JSON path unless `keepMissing`.
- [ ] Memory: evidence `messageId`, labels identities keyed by `ParticipantKey`, trace sources, every other stored id. Declare `settings` and `labels`.
- [ ] Race: slot `participantId`; declare its Participant stats value.
- [ ] Audit the other Boxes (Author Note, Mood, Phone, Thought, World Clock) and the tip-jar e2e fixture for stored ids and undeclared keys.
- [ ] Document Row References and the new descriptor key in `docs/box-system/README.md`.
- [ ] Contract tests for the walker: ids under Record keys, nested Arrays and Union branches are rewritten; a missing id throws with its path; `keepMissing` leaves it.
- [ ] Run focused tests, typechecking, and the full test suite.
- [ ] Set this ticket to DONE and commit.

## Acceptance

- No Box schema holds a row id as a plain `Type.Integer` or a plain string key.
- Writing an undeclared Box Chat or Participant key fails.
