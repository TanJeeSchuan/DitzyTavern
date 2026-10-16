import { Fragment } from "react";
import type { ConversationSummary } from "../conversation";
import type { BoxId } from "../../shared/contract/box";
import { BoxBoundary, BoxFailure } from "../box-windows/BoxBoundary";
import { boxClients, boxPresent, errorMessage } from "../box-windows/registry";
import { assertLensPieces } from "../../shared/contract/box-descriptor";
import type { LensPiece } from "../box-windows/lens";
import { Prose } from "./prose";

/** @approved What the story's lenses need: the Chat, which gates each lens, and how a lifted mark opens its Box. */
export type StoryLens = { readonly conversation: ConversationSummary; open(box: BoxId): void };

// @approved
//  Lenses apply in registry order, each to the prose the earlier ones left.
//  A lifted piece is never lensed again. A lens that throws, or returns
//  pieces that fail their schema, leaves its prose unlifted behind its
//  failure, and each lifted mark renders in its Box's boundary.
export function LensedProse({ text, streaming, lens }: { text: string; streaming: boolean; lens: StoryLens | undefined }) {
	const lenses = lens === undefined ? [] : [...boxClients()].flatMap(([id, { Window }]) => {
		const boxLens = Window?.lens;
		if (boxLens === undefined || !boxPresent(lens.conversation, id)) return [];
		const failed = (message: string, prose: string): LensPiece[] => [{ kind: "lifted", element: <BoxFailure box={id} message={message} /> }, { kind: "prose", text: prose }];
		try {
			const lift = boxLens.gate(lens.conversation);
			return lift === undefined ? [] : [{ tag: boxLens.tag, lift: (prose: string): readonly LensPiece[] => {
				try {
					const pieces = lift(prose, () => lens.open(id));
					assertLensPieces(pieces);
					return pieces.map((piece) => piece.kind === "prose" ? piece : { kind: "lifted", element: <BoxBoundary box={id}>{piece.element}</BoxBoundary> });
				} catch (error) {
					return failed(errorMessage(error), prose);
				}
			} }];
		} catch (error) {
			return [{ tag: boxLens.tag, lift: (prose: string) => failed(errorMessage(error), prose) }];
		}
	});
	if (lenses.length === 0) return <Prose text={text} streaming={streaming} />;
	const shown = streaming ? lenses.reduce((visible, { tag }) => {
		const open = visible.lastIndexOf(`<${tag}`);
		return open !== -1 && !visible.includes(`</${tag}>`, open) ? visible.slice(0, open) : visible;
	}, text) : text;
	const pieces = lenses.reduce<readonly LensPiece[]>((current, { lift }) => current.flatMap((piece) => piece.kind === "prose" ? lift(piece.text) : [piece]), [{ kind: "prose", text: shown }])
		.filter((piece) => piece.kind === "lifted" || piece.text.trim() !== "");
	return pieces.map((piece, index) => piece.kind === "prose"
		? <Prose key={index} text={piece.text} streaming={streaming && index === pieces.length - 1} />
		: <Fragment key={index}>{piece.element}</Fragment>);
}
