# Let Boxes answer each other through Exports

[ADR-0050](0050-build-story-features-as-boxes.md) let Boxes compose only through the Prompt Plan. The Character Drafter needs what Memory and Thoughts know about a person, and copying their extraction would build Memory a second time. So a built-in Box may declare Box Exports: named, read-only questions about its own state in one Chat, each with an input and an output schema, answered synchronously. Another built-in Box reads every enabled Box's Exports in a Chat through `boxExports`, and only from its route handlers. The host checks input and output against the declared schemas, so the consumer never sees the provider's records, storage or types.

Exports are readable from routes and not from `advance`, digests or `fold`. Reading another Box there would make a Box's result depend on state outside its `dependencies`, so the preview fingerprint would miss the change, and a swipe would no longer reproduce the same outcome. ADR-0050's rule still holds for everything that shapes a Generation: Boxes advance in parallel and never read each other's output from the same turn.

## Considered Options

- Making drafting a core Cast feature that reads Memory: rejected because the core would then consume a Box, and no Box would ever consume another, which leaves the cross-Box case untested.
- Letting a consumer read the provider's records through its own SDK reads: rejected because it couples the consumer to the provider's record schema, label merges and Writer override rules, which are the provider's to interpret.
- Declaring the Exports a Box uses: rejected because nothing reads the list. A missing provider is simply absent from `boxExports`.
- Exports for sandboxed Boxes: deferred. A sandboxed Box reaches models and other state only through what ADR-0053 hands it, and widening that is a separate decision.
