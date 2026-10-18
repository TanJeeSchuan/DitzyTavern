import type { LucideIcon } from "lucide-react";
import type { BoxId } from "../../shared/contract/box";
import type { ConversationSummary } from "../conversation";
import { BoxFailure, BoxIcon } from "../box-windows/BoxBoundary";
import { boxClients, boxPresent, errorMessage } from "../box-windows/registry";
import { assertLensPieces } from "../../shared/contract/box-descriptor";
import { Prose } from "./prose";

/** @approved What the story's lenses need: the Chat, which gates each lens, and how a lifted mark opens its Box. */
export type StoryLens = { readonly conversation: ConversationSummary; open(box: BoxId): void };

type StoryPiece =
	| { readonly kind: "prose"; readonly text: string }
	| { readonly kind: "lifted"; readonly box: BoxId; readonly icon: LucideIcon; readonly line: string }
	| { readonly kind: "failed"; readonly box: BoxId; readonly message: string };

//  Lenses apply in registry order, each to the prose the earlier ones left.
//  A lifted piece is never lensed again. A lens that throws, or returns
//  pieces that fail their schema, leaves its prose unlifted behind its
//  failure, and the host draws each lifted mark.
export function LensedProse({ text, streaming, lens }: { text: string; streaming: boolean; lens: StoryLens | undefined }) {
	if (lens === undefined) return <Prose text={text} streaming={streaming} />;
	const lenses = [...boxClients()].flatMap(([id, { Window, icon }]) => {
		const boxLens = Window?.lens;
		if (boxLens === undefined || !boxPresent(lens.conversation, id)) return [];
		const failed = (message: string, prose: string): StoryPiece[] => [{ kind: "failed", box: id, message }, { kind: "prose", text: prose }];
		try {
			const lift = boxLens.gate(lens.conversation);
			return lift === undefined ? [] : [{ tag: boxLens.tag, lift: (prose: string): readonly StoryPiece[] => {
				try {
					const pieces = lift(prose);
					assertLensPieces(pieces);
					return pieces.map((piece) => piece.kind === "prose" ? piece : { kind: "lifted", box: id, icon, line: piece.line });
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
	const pieces = lenses.reduce<readonly StoryPiece[]>((current, { lift }) => current.flatMap((piece) => piece.kind === "prose" ? lift(piece.text) : [piece]), [{ kind: "prose", text: shown }])
		.filter((piece) => piece.kind !== "prose" || piece.text.trim() !== "");
	return pieces.map((piece, index) => piece.kind === "prose"
		? <Prose key={index} text={piece.text} streaming={streaming && index === pieces.length - 1} />
		: piece.kind === "failed"
			? <BoxFailure key={index} box={piece.box} message={piece.message} />
			: <button key={index} type="button" className="box-lens-mark" onClick={() => lens.open(piece.box)}>
				<BoxIcon box={piece.box} icon={piece.icon} />{piece.line}
			</button>);
}
