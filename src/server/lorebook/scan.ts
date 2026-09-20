/** ==[HUMAN APPROVED]== The scan source is selected narrative text only. Definitions,
 * instructions, and reasoning are excluded before this seam is called. */
export interface LoreScanSourceMessage {
	readonly id: number;
	readonly content: string;
}

export interface LoreScanWindowInput {
	readonly messages: readonly LoreScanSourceMessage[];
	/** ==[HUMAN APPROVED]== The human text submitted by a Send, before it exists as a Message. */
	readonly pendingHumanText?: string;
	/** ==[HUMAN APPROVED]== A Sibling target; the target and every later Message are excluded. */
	readonly beforeMessageId?: number;
	/** ==[HUMAN APPROVED]== Number of individual Messages, regardless of author. Defaults to four. */
	readonly depth?: number;
}

export interface LoreScanWindowMessage {
	readonly id: number | null;
	readonly content: string;
	readonly pending: boolean;
}

export const DEFAULT_LORE_SCAN_DEPTH = 4;

/** ==[HUMAN APPROVED]== Capture once for an attempt; budgeting must consume this result without rescanning. */
export const captureLoreScanWindow = (
	input: LoreScanWindowInput,
): readonly LoreScanWindowMessage[] => {
	const depth = input.depth ?? DEFAULT_LORE_SCAN_DEPTH;
	if (!Number.isInteger(depth) || depth < 0) throw new Error("Lore scan depth must be a non-negative whole number.");
	if (depth === 0) return [];
	const targetIndex = input.beforeMessageId === undefined
		? input.messages.length
		: input.messages.findIndex((message) => message.id === input.beforeMessageId);
	const boundedMessages = targetIndex < 0 ? input.messages : input.messages.slice(0, targetIndex);
	const pending = input.beforeMessageId !== undefined || input.pendingHumanText === undefined || input.pendingHumanText.length === 0
		? []
		: [{ id: null, content: input.pendingHumanText, pending: true } satisfies LoreScanWindowMessage];
	return [...boundedMessages.map((message) => ({
		id: message.id,
		content: message.content,
		pending: false,
	})), ...pending].slice(-depth);
};
