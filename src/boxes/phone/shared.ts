import type { PhoneMove, PhoneText } from "./contract";

/** @approved The names a text may pass between: the human-controlled Participant and the other Cast members. */
export type PhoneNames = { readonly human: string; readonly contacts: readonly string[] };
export type Sms = Omit<PhoneText, "key">;
export type PhoneSegment = { readonly kind: "prose"; readonly text: string } | { readonly kind: "sms"; readonly text: Sms };

/** @approved Contacts are the other Cast members, one per name, since the markup names them. */
export const phoneNames = (cast: readonly { readonly id: number; readonly name: string }[], human: { readonly id: number; readonly name: string }): PhoneNames =>
	({ human: human.name, contacts: [...new Set(cast.flatMap(({ id, name }) => id === human.id || name === human.name ? [] : [name]))] });

/** @approved The Phone block's default instructions; the Box adds only who the human can text. */
export const phoneInstructions =
	'Write each text on its own line as <sms from="{{other}}" to="{{self}}">message</sms>, with the sender in from and the recipient in to. Narrate around a text; never restate it in the prose.';

// @approved
//  The body may not contain another `<sms` or `</sms`, so in nested markup
//  only the innermost pair matches and the outer tags stay raw text.
const SMS = /<sms\s+from="([^"<>]*)"\s+to="([^"<>]*)"\s*>((?:(?!<\/?sms\b)[\s\S])*)<\/sms>/g;

export const phoneMoveLabel = ({ to, text }: PhoneMove): string => `📱 ${to}: ${text}`;

// @approved
//  Rendering escapes only what would break the markup: a quote or angle
//  bracket in a name, `<sms` or `</sms` in a body, and an `&` that would
//  read as one of these entities. Everything else stays as written.
const ENTITIES = new Map([["&amp;", "&"], ["&quot;", "\""], ["&lt;", "<"], ["&gt;", ">"]]);
const CHARACTERS = new Map([...ENTITIES].map(([entity, character]) => [character, entity]));
/** @approved Each pattern below matches only characters or entities these maps hold. */
const escape = (pattern: RegExp) => (text: string) => text.replace(pattern, (character) => CHARACTERS.get(character)!);
const escapeName = escape(/&(?=(?:amp|quot|lt|gt);)|["<>]/g);
const escapeBody = escape(/&(?=(?:amp|quot|lt|gt);)|<(?=\/?sms\b)/g);
const decode = (text: string) => text.replace(/&(?:amp|quot|lt|gt);/g, (entity) => ENTITIES.get(entity)!);

export const renderPhoneText = ({ from, to, text }: Sms): string => `<sms from="${escapeName(from)}" to="${escapeName(to)}">${escapeBody(text)}</sms>`;

/** @approved Names match ignoring case and surrounding space; the segment carries the Cast spelling. */
export function stripPhoneTexts(text: string, { human, contacts }: PhoneNames): PhoneSegment[] {
	const known = (name: string) => [human, ...contacts].find((candidate) => candidate.toLowerCase() === name.trim().toLowerCase());
	const segments: PhoneSegment[] = [];
	let at = 0;
	for (const match of text.matchAll(SMS)) {
		/** @approved SMS always captures its three groups. */
		const from = known(decode(match[1]!));
		const to = known(decode(match[2]!));
		const body = decode(match[3]!).trim();
		if (from === undefined || to === undefined || from === to || (from !== human && to !== human) || body === "") continue;
		segments.push({ kind: "prose", text: text.slice(at, match.index) }, { kind: "sms", text: { from, to, text: body } });
		at = match.index + match[0].length;
	}
	segments.push({ kind: "prose", text: text.slice(at) });
	return segments.filter((segment) => segment.kind === "sms" || segment.text.trim() !== "");
}
