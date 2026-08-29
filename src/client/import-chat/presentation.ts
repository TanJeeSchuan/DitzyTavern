import type { ImportGroupDraft } from "../import-chat-flow";
import { formatSize } from "../lib/format";

export const sourceSize = (byteLength: number | null): string =>
	formatSize(byteLength, "");

export const outcomeLabel = (
	outcome: ImportGroupDraft["outcome"],
): string =>
	outcome.type === "fork"
		? "Existing Character"
		: outcome.type === "new-character"
			? "New Character"
			: "Chat-only";

