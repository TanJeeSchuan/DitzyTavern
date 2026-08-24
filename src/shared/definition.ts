// Shared Prompt presentation derivation. The server uses these rules to put
// a short preview on Character Library list entries (so the Cast picker
// never needs one detail request per Character), and clients use the same
// helpers for any local formatting.

export interface TypedPrompt {
	systemInstruction: string;
	identity: string;
	scenario: string;
	exampleDialogue: string;
	postHistoryInstruction: string;
}

// First non-empty Prompt field in the agreed presentation order.
export const firstPromptText = (prompt: TypedPrompt): string =>
	[
		prompt.systemInstruction,
		prompt.identity,
		prompt.scenario,
		prompt.exampleDialogue,
		prompt.postHistoryInstruction,
	].find((field) => field.trim() !== "") ?? "";

export const promptPreview = (value: string, maxLength = 140): string => {
	const trimmed = value.trim();
	if (trimmed === "") return "No prompt text yet.";
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, maxLength).trimEnd()}…`;
};