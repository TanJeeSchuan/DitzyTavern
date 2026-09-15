# Assemble lore through a budgeted preset block

Selected Lore Entries enter the Prompt Plan through one referenced Lore block controlled by the Prompt Preset. Its initial position is immediately before history, with an editable role defaulting to system. Per-entry history-depth placement and named outlets are deferred. This extends ADR-0036's preset content slots to cover lore without putting placement rules into shared books.

A Prompt Preset may contain at most one Lore block. This is an explicit exception to ADR-0036's general permission to duplicate referenced slots; lore must not be repeated through duplicate recipe slots.

New Default recipes include Lore before history. Existing saved recipes gain it through an explicit Add Lore Block action, preserving their authored order. When books are attached but the recipe has no enabled Lore block, explain why lore is inactive and offer the applicable add or enable action.

For new SillyTavern preset imports, map the first enabled World Info placeholder in the selected source order to the single Lore block. If all World Info placeholders are disabled, retain the first as disabled. Omit the other positions with warnings that they were collapsed. Reject native imports containing multiple Lore blocks, including disabled occurrences. Previously discarded source positions cannot be recovered from existing saved presets.

Each Chat has a lore allowance, initially 2,048 estimated tokens. Reserve the response budget, fixed preset content and protected history first. Within the available lore allowance, consider Always Entries first, then author-assigned entry priority, using stable ordering for ties. Admit whole entries, skipping an entry that does not fit and continuing to smaller entries. Older history uses the remaining space. Always bypasses trigger conditions, not the budget; this policy deliberately lets selected lore displace older history while preserving the protected writing context.

Match once against the captured Lore Scan Window before budgeting. History removal does not rerun matching, and selected lore may remain even when its triggering Message is omitted from the final prompt. This avoids circular selection where admitting lore removes history, changes matching and then restores history.

Within the Always and conditional groups, higher numeric priority wins; ties follow stable book creation/import order, then the entry's editable order within its book. Entry priority defaults to zero. Use this same sequence for admission and final Lore block text. Attachment paths do not add priority or duplicate entries.
