# Let Boxes answer each other through Exports

[ADR-0050](0050-build-story-features-as-boxes.md) let Boxes compose only through the Prompt Plan. The Character Drafter needs Memory's Claims about a person. Box Exports let the Drafter read those Claims without reimplementing Memory's extraction or interpreting its records. [Box Export rules](../box-system/README.md#the-rules)

Generation logic runs on captured inputs. An Export read during Generation would introduce a dependency outside the preview fingerprint and could change the outcome of a Swipe. The composition rule from ADR-0050 still applies within a Generation.

## Considered Options

- Making drafting a core Cast feature that reads Memory: rejected because the core would then consume a Box, and no Box would ever consume another, which leaves the cross-Box case untested.
- Letting a consumer read the provider's records through its own SDK reads: rejected because it couples the consumer to the provider's record schema, label merges and Writer override rules, which are the provider's to interpret.
- Declaring the Exports a Box uses: rejected because nothing reads the list. A missing provider is simply absent from `exportsOf`'s answer.
- Exports for sandboxed Boxes: deferred. A sandboxed Box reaches models and other state only through what ADR-0053 hands it, and widening that is a separate decision.
