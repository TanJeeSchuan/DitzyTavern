# Generation lifecycle collapse

Status: DONE

Blocked By:

- `01-model-transport-canonicalization.md`
- `02-connection-settings-canonicalization.md`

Source: `.scratch/thermo-nuclear-code-quality-review-full-codebase.md`, findings F2 and F3.

## Goal

Collapse the repeated Send, Continue, and Sibling generation orchestration around the seams that already own capture, acceptance, notification, and execution.

## Ownership

- `src/server/workflows/generate.ts`
- `src/server/conversation/commands/accept-generation.ts`
- Direct lifecycle types or focused tests required by the refactor

Avoid unrelated cleanup in model-client, connection-settings, or conversation read modules. Earlier tickets own those areas.

## Work

- [x] Parameterize the shared accepted-generation tail for Send and Continue.
- [x] Let Sibling reuse the shared accept, notify, run, and remove structure where its revision-neutral semantics allow it.
- [x] Encode lifecycle differences through typed inputs or policies instead of scattered conditionals.
- [x] Make it impossible for Continue to insert a human Message through the shared abstraction.
- [x] Replace the three repeated acceptance-field attendance sheets with spread input plus the lifecycle-specific hooks.
- [x] Keep Send reuse validation, Continuation terminal validation, and Sibling revision-neutral behavior explicit.
- [x] Preserve HTTP contracts, wire schemas, revision behavior, and error-message precedence.
- [x] Confirm the targeted `generate.ts` clone families disappear or shrink through `bun run check:clones`.
- [x] Run the Send, Continue, Sibling, recovery, and workflow tests, typechecking, and the full test suite.
- [ ] Run `/code-review` with Luna XHigh review subagents and resolve its findings.
- [x] Set this ticket to DONE and commit the implementation.

## Acceptance

- Send and Continue no longer restate the same orchestration skeleton.
- Sibling shares the common accepted-generation tail without hiding its distinct revision rules.
- Common acceptance fields are not listed by hand at all three call sites.
- Observable behavior and error precedence remain unchanged.
