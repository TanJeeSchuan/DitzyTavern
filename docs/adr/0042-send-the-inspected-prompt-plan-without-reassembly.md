# Send the inspected Prompt Plan without reassembly

The Prompt Plan the user inspects, including accepted manual edits, is the writing context sent to the model API. A Prompt Preset is its assembly recipe, not the assembled result. This makes explicit the guarantee established by ADR-0021 and ADR-0037 and extends it to lore selection and embedding fallback.

Starting Generation from inspection must not rerun lore matching, recover semantic results behind the user's back, expand macros again, reroll values, add instructions or silently trim the inspected content. A preview assembled using keyword fallback retains that result even if the embedding service recovers before sending. Explicit Refresh performs a new assembly. Changes to captured preparation require a refresh rather than silent reassembly; already captured Generations remain fixed.

The Model Client still encodes the captured plan into the selected API's request format, including its roles and Generation intent. This guarantee concerns the complete inspected model input, not byte-for-byte identity between a provider-neutral plan and vendor JSON. Validation may reject an invalid, stale or oversized plan; it must not repair the plan into different text and send that instead. Preferring the latest available lore over the inspected result was rejected because it would make inspection an unreliable account of what the model receives.

Fresh Generations and Swipes assemble from current saved inputs using their existing attempt-specific history and control rules. This decision does not change how long completed inspection records are retained.
