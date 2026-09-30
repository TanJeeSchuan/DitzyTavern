# Match separately authored Semantic Triggers

> Superseded in part by [ADR-0044](0044-judge-semantic-triggers-with-jev.md) (judge Semantic Triggers with Typesafe Jev). The authored-trigger model, AND/OR operator, secondary conditions, literal fields and whole-Generation keyword fallback stand. The sentence-embedding matcher, application-wide embedding configuration, cosine threshold and embedding deadline described below are replaced.

A Lore Entry's Semantic Triggers are authored separately from its Keywords and lore content. Semantic matching uses those phrases as its target, allowing the author to describe when lore is relevant without making the same text serve both literal and semantic matching.

This deliberately differs from [SillyTavern's vector matching](../research/sillytavern-lorebooks.md), which embeds full entry content. Using the whole entry would let incidental facts and content edits change what situations match. Keeping a separate authored field requires more authoring work but gives the author direct control over the semantic target.

Each entry chooses AND or OR between its Keyword and Semantic Trigger matcher results. The chosen operator determines whether one matcher or both must succeed.

Only populated lists participate, and any match within a list succeeds. The operator defaults to OR. With no triggers, a conditional entry does not match. An explicit Always setting bypasses trigger conditions but remains subject to the prompt budget.

Conditional entries can require any or all secondary Keywords, or exclude activation when any or all secondary Keywords match. This condition gates the combined matcher result, including semantic hits. Always entries bypass it. This deliberately differs from SillyTavern's semantic bypass of secondary keyword checks.

A Keyword or regex matches within one complete Message. Primary and secondary results combine across the Lore Scan Window, so a secondary exclusion in a different scanned Message can block activation. Do not manufacture a matching phrase by joining the end of one Message to the start of another.

Semantic matching compares each trigger with individual sentences from the Lore Scan Window. The strongest matching sentence supplies the trigger's score. This keeps a relevant sentence from being diluted by unrelated material in a long Message, at the cost of losing context that spans sentences.

Use one application-wide embedding configuration with its own endpoint, credential, model, default threshold and deadline. Compare embeddings using cosine similarity. The default threshold starts at an editable 0.70, with optional per-entry overrides and a match tester showing the strongest sentence and score. This initial value is not calibrated across models and does not guarantee relevance.

Embeddings are reusable derived data tied to their source text and embedding endpoint/model. A model or endpoint change requires corresponding embeddings rather than comparing vectors produced by different models. Rebuild what is needed from the authored text, applying the approved fallback if required embeddings cannot be obtained.

Authored edits can be saved independently of the embedding service. When embeddings are unavailable, keyword fallback lets writing continue: evaluate Keywords alone even for AND entries, skip semantic-only entries, retain secondary Keyword conditions and indicate that fallback was used. Always entries remain eligible. This deliberately relaxes an AND entry's semantic requirement during unavailability, as requested by the user.

Use either a complete semantic evaluation or keyword-only fallback for the whole Generation, rather than mixing partial semantic results and fallback across entries. Required embedding work has a configurable deadline initially set to five seconds.

All Lore Entry fields remain literal. Do not evaluate Prompt Macros in entry content, Keywords or Semantic Triggers. This avoids attachment-relative macro meaning and variable side effects when a shared entry is matched, omitted for budget or rendered.
