# Retain Lore Activation Records with Variants

Keep each Generation's Lore Activation Record for as long as its Variant is retained. Each sibling keeps its own record. There is no five-minute expiry for these explanations: users need to inspect why old writing used or omitted particular lore after editing the books or changing the selected story path.

Capture the attempt's matching and admission evidence instead of reconstructing it from current mutable books. This includes the relevant matching text and scores, conditions, budget decisions and fallback status. Later book edits or deletion must not erase or rewrite the historical explanation; deleting the owning Variant removes its record. Re-running the match tester evaluates current inputs and is not a substitute for an old attempt's evidence.

When the user edits an inspected Lore block, retain the original automatic activation explanation and the final edited Lore text. Mark the manual edit explicitly. Do not infer entry identities from arbitrary replacement text or claim that automatically selected content was sent unchanged when the user edited it.

This extends the retained provenance of a Variant beyond ADR-0021's original transient-inspection scope. The extra stored evidence is accepted in exchange for dependable historical troubleshooting. It does not require retaining the entire Prompt Plan or provider request permanently.
