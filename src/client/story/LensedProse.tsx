import type { PhoneNames } from "../../shared/phone";
import { boxWindows, type WindowBoxId } from "../box-windows/registry";
import { Prose } from "./prose";

/** @approved What the story's lenses need: who may text whom, and how a lifted text opens its Box. */
export type StoryLens = { readonly names: PhoneNames; open(box: WindowBoxId): void };

export function LensedProse({ text, streaming, lens }: { text: string; streaming: boolean; lens: StoryLens | undefined }) {
	if (lens === undefined) return <Prose text={text} streaming={streaming} />;
	const { strip, View } = boxWindows.phone.lens;
	// @approved
	//  A text still streaming has no closing tag yet; it stays hidden rather
	//  than flash as markup.
	const open = text.lastIndexOf("<sms");
	const shown = streaming && open !== -1 && !text.includes("</sms>", open) ? text.slice(0, open) : text;
	const segments = strip(shown, lens.names);
	return segments.map((segment, index) => segment.kind === "prose"
		? <Prose key={index} text={segment.text} streaming={streaming && index === segments.length - 1} />
		: <View key={index} text={segment.text} onOpen={() => lens.open("phone")} />);
}
