import type { ConversationSummary } from "./contract/conversation-schema";
import { formatImageReference, parseImageReferences, type ImageReference } from "./image-reference";

type Cast = ConversationSummary["cast"];

export const namesCastMember = (text: string, name: string): boolean =>
	new RegExp(`(?<![\\p{L}\\p{N}_])${RegExp.escape(name)}(?![\\p{L}\\p{N}_])`, "iu").test(text);

export const keptBriefReferences = (brief: string, cast: Cast): ImageReference[] => {
	const appearance = new Set(cast.flatMap((participant) => parseImageReferences(participant.prompt.appearance).map(({ hash }) => hash)));
	return parseImageReferences(brief).filter(({ hash }) => !appearance.has(hash));
};

export const appendBriefReferences = (brief: string, cast: Cast, kept: readonly ImageReference[]): string => {
	const seen = new Set(parseImageReferences(brief).map(({ hash }) => hash));
	const appearance = cast.filter((participant) => participant.sendAppearanceImages && namesCastMember(brief, participant.name))
		.flatMap((participant) => parseImageReferences(participant.prompt.appearance));
	const appended = [...appearance, ...kept].flatMap(({ name, hash }) => {
		if (seen.has(hash)) return [];
		seen.add(hash);
		return [formatImageReference(name, hash)];
	});
	return [brief, ...appended].filter(Boolean).join("\n\n");
};
