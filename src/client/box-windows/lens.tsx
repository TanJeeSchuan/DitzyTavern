import type { ComponentType, ReactElement } from "react";
import type { ConversationSummary } from "../conversation";

// @approved
//  The story view replaces each `<tag>` a lens lifts with a mark that opens
//  the Box; the prompt keeps the markup. `gate` returns nothing when the lens
//  has nothing to lift in this Chat. While streaming, an unclosed `<tag`
//  stays hidden rather than flash as markup.
export interface BoxLens {
	readonly tag: string;
	gate(conversation: ConversationSummary): ((text: string, onOpen: () => void) => readonly LensPiece[]) | undefined;
}
export type LensPiece = { readonly kind: "prose"; readonly text: string } | { readonly kind: "lifted"; readonly element: ReactElement };

type Segment<Kind extends string, Text> = { readonly kind: "prose"; readonly text: string } | { readonly kind: Kind; readonly text: Text };
export const createBoxLens = <Context, Kind extends string, Text>(
	tag: Kind,
	gate: (conversation: ConversationSummary) => Context | undefined,
	strip: (text: string, context: Context) => readonly Segment<Kind, Text>[],
	View: ComponentType<{ text: Text; onOpen: () => void }>,
): BoxLens => {
	const lifted = (segment: Segment<Kind, Text>): segment is { readonly kind: Kind; readonly text: Text } => segment.kind === tag;
	return {
		tag,
		gate: (conversation) => {
			const context = gate(conversation);
			return context === undefined ? undefined : (text, onOpen) => strip(text, context).map((segment) => lifted(segment)
				? { kind: "lifted", element: <View text={segment.text} onOpen={onOpen} /> }
				: { kind: "prose", text: segment.text });
		},
	};
};
