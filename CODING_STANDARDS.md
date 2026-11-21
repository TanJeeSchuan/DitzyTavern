# Coding standards

## Code

- Prefer Radix/shadcn or existing code over hand-rolled UI.
- Remove obsolete paths when behaviour changes. Backward compatibility is not a goal, so add no compatibility layers, fallbacks, or mitigations.
- Exhaustive declarations should encode information. An exhaustive object whose values are all identical and that has no consumer is a compiler-enforced attendance sheet; remove it.
- Fix an overlong line by restructuring the code, or leave it. Never wrap it mechanically.

## One fact, one home

A fact kept in two places needs code to keep the copies in agreement, and that code is where this codebase's bugs and bulk have come from. Give each fact one home and derive the rest.

- On the client, server data lives in the query cache. A reducer or `useState` holds only what the user has done that the server does not know yet: a draft, a Preview, a requested selection. Everything else is derived at render.
- Order responses with the query key or a component `key` that names what they belong to (the Chat, its revision, the preset). A response for an old key then has nowhere to land.
- Declare a wire shape once in `src/shared/contract/` and derive its type with `Static<>`. The server, the client and tests import that declaration.
- A Conversation's rows change through a Conversation command (`executeConversationCommand`). A module that needs a new write adds a command.
- A stage in a pipeline passes its input along and adds fields. It builds a new shape only when the next stage needs different facts.
- A parameter that every caller passes is required.
- A route handler decodes the request, calls one domain function and encodes the result. A rule lives in the domain function.

## Removing code

Before deleting something with no caller, decide which it is:

- **Internal code**: delete it.
- **Surface** (a Box SDK export, a Box descriptor hook, an HTTP command, a stored-value kind): ask what it lets an author do that nothing else does. Removing surface is the owner's decision, so raise it instead of deleting it.

## Box host code

Every call into Box code, and every read of Box-shaped data, survives the Box throwing, returning the wrong shape, never settling, or no longer being loaded. [`docs/box-system/README.md`](docs/box-system/README.md) owns the Box rules: [the contract](docs/box-system/README.md#the-contract), [the rules](docs/box-system/README.md#the-rules) and [loading](docs/box-system/host.md#loading). When a ticket touches a rule that file owns, link its section instead of restating it.

## Tests

- Every assertion rejects a plausible incorrect behaviour; name it before you write the assertion. Tautological tests are harmful.
- A bug fix comes with a test that fails before the fix.
- A refactor needs no test against architectural regression: unifying hand-written identical declarations into one needs no test that catches them splitting again.
- A reducer test drives a sequence a user or the server could produce and asserts what a user would observe. Asserting the exact next state or effect list after one action transcribes the reducer and breaks on every refactor.
- A test in `src/server/contract/` asserts what the HTTP layer decides: status, envelope, body validation, SSE framing. A domain rule is tested beside its domain function.
- Build Chats and Participants with `src/server/test-fixtures/conversation.ts` and `emptyPromptChannels()`.
- A wait has a bound and fails when it reaches it.

## Docs and reviews

- Check every claim in agent-facing docs against the code.
- A claim from a subagent's report is unverified until you have read the lines it cites. Say which claims you verified.
- A structural proposal names what it removes, what it introduces, and what behaviour changes. Pass previously rejected approaches into each later review. "I can imagine another architecture" is too cheap to block an approval.
