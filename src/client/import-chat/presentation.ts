import type { ImportGroupDraft } from "../import-chat-flow";

export const sourceSize = (byteLength: number | null): string => {
	if (byteLength === null) return "";
	if (byteLength < 1024) return `${byteLength} B`;
	const kilobytes = byteLength / 1024;
	if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
	return `${(kilobytes / 1024).toFixed(1)} MB`;
};

export const outcomeLabel = (
	outcome: ImportGroupDraft["outcome"],
): string =>
	outcome.type === "fork"
		? "Existing Character"
		: outcome.type === "new-character"
			? "New Character"
			: "Chat-only";

