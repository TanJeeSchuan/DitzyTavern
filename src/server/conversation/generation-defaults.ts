// ==[HUMAN APPROVED]== The canonical Generation Settings defaults that storage must state:
// the settings-table column defaults and the fallback reads of a missing
// settings row consume these constants so a stored default, a read fallback,
// and a gate comparison can never drift apart. Declared without module
// imports so the database schema can align with them directly.

export const DEFAULT_SIBLING_GENERATION_LIMIT = 4;
export const DEFAULT_CONTINUATION_STRATEGY = "instruction";
