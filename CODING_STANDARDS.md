# Coding standards

## Code

- Prefer Radix/shadcn or existing code over hand-rolled UI.
- Remove obsolete paths when behaviour changes. Backward compatibility is not a goal, so add no compatibility layers, fallbacks, or mitigations.
- Exhaustive declarations should encode information. An exhaustive object whose values are all identical and that has no consumer is a compiler-enforced attendance sheet; remove it.
- Fix an overlong line by restructuring the code, or leave it. Never wrap it mechanically.

## Box host code

Every call into Box code, and every read of Box-shaped data, survives the Box throwing, returning the wrong shape, never settling, or no longer being loaded. [`docs/box-system/README.md`](docs/box-system/README.md) owns the Box rules: [the contract](docs/box-system/README.md#the-contract), [the rules](docs/box-system/README.md#the-rules) and [loading](docs/box-system/README.md#loading). When a ticket touches a rule that file owns, link its section instead of restating it.

## Tests

- Every assertion rejects a plausible incorrect behaviour; name it before you write the assertion. Tautological tests are harmful.
- A bug fix comes with a test that fails before the fix.
- A refactor needs no test against architectural regression: unifying hand-written identical declarations into one needs no test that catches them splitting again.

## Docs and reviews

- Check every claim in agent-facing docs against the code.
- A structural proposal names what it removes, what it introduces, and what behaviour changes. Pass previously rejected approaches into each later review. "I can imagine another architecture" is too cheap to block an approval.
