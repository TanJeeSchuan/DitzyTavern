import type { ConversationSummary } from "../conversation";

// @approved
//  The story view replaces each `<tag>` a lens lifts with a mark that opens
//  the Box; the prompt keeps the markup. `gate` returns nothing when the lens
//  has nothing to lift in this Chat. While streaming, an unclosed `<tag`
//  stays hidden rather than flash as markup.
export interface BoxLens {
	readonly tag: string;
	gate(conversation: ConversationSummary): ((text: string) => readonly LensPiece[]) | undefined;
}
export type LensPiece = { readonly kind: "prose"; readonly text: string } | { readonly kind: "lifted"; readonly line: string };

type Segment<Kind extends string, Text> = { readonly kind: "prose"; readonly text: string } | { readonly kind: Kind; readonly text: Text };
export const createBoxLens = <Context, Kind extends string, Text>(
	tag: Kind,
	gate: (conversation: ConversationSummary) => Context | undefined,
	strip: (text: string, context: Context) => readonly Segment<Kind, Text>[],
	describe: (run: readonly Text[]) => string,
): BoxLens => {
	const lifted = (segment: Segment<Kind, Text>): segment is { readonly kind: Kind; readonly text: Text } => segment.kind === tag;
	const pieces = (segments: readonly Segment<Kind, Text>[]): LensPiece[] => {
		const result: LensPiece[] = [];
		let run: Text[] = [];
		const flush = () => {
			if (run.length === 0) return;
			result.push({ kind: "lifted", line: describe(run) });
			run = [];
		};
		for (const segment of segments) {
			if (lifted(segment)) { run.push(segment.text); continue; }
			if (segment.text.trim() === "") continue;
			flush();
			result.push(segment);
		}
		flush();
		return result;
	};
	return {
		tag,
		gate: (conversation) => {
			const context = gate(conversation);
			return context === undefined ? undefined : (text) => pieces(strip(text, context));
		},
	};
};
