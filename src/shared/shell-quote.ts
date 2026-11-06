// @approved
//  One word a POSIX shell and PowerShell both read literally, for commands
// the app prints for the writer or an agent to copy: single-quoted, so `$`,
// backticks, spaces and globs are plain text in both. A `'` can't be quoted
// the same way in both shells, so a word holding one has no such form.
export const shellWord = (word: string): string | undefined => word.includes("'") ? undefined : `'${word}'`;
