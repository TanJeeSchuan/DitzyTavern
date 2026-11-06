// @approved
//  One shell word for a POSIX shell, single-quoted so nothing in it expands:
// `$`, backticks, spaces and globs are literal, and a `'` is closed, escaped
// and reopened. Used for commands the app prints for the writer to copy.
export const shellQuote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;
