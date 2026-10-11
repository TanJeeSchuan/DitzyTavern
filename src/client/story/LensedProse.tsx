import { Fragment } from "react";
import type { ConversationSummary } from "../conversation";
import { boxWindows, windowBoxIds, type BoxWindowDefinition, type LensPiece, type WindowBoxId } from "../box-windows/registry";
import { Prose } from "./prose";

/** @approved What the story's lenses need: the Chat, which gates each lens, and how a lifted mark opens its Box. */
export type StoryLens = { readonly conversation: ConversationSummary; open(box: WindowBoxId): void };

// @approved
//  Lenses apply in registry order, each to the prose the earlier ones left.
//  A lifted piece is never lensed again.
export function LensedProse({ text, streaming, lens }: { text: string; streaming: boolean; lens: StoryLens | undefined }) {
	const lenses = lens === undefined ? [] : windowBoxIds.flatMap((id) => {
		const { lens: boxLens }: BoxWindowDefinition = boxWindows[id];
		const lift = lens.conversation.boxes[id] === "enabled" ? boxLens?.gate(lens.conversation) : undefined;
		return boxLens === undefined || lift === undefined ? [] : [{ tag: boxLens.tag, lift: (prose: string) => lift(prose, () => lens.open(id)) }];
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
