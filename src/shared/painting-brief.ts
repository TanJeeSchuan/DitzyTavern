import { castNameMatches } from "./literal-matching";
import type { ConversationSummary } from "./contract/conversation-schema";
import { formatImageReference, parseImageReferences, projectImageAnchors, sanitizeImageName, type ImageReference } from "./image-reference";

type Cast = ConversationSummary["cast"];

export const keptBriefReferences = (brief: string, cast: Cast): ImageReference[] => {
	const appearance = new Set(cast.filter((participant) => participant.sendAppearanceImages).flatMap((participant) => parseImageReferences(participant.prompt.appearance).map(({ hash }) => hash)));
	return parseImageReferences(brief).filter(({ hash }) => !appearance.has(hash));
};

export const appendBriefReferences = (brief: string, cast: Cast, kept: readonly ImageReference[]): string => {
	const seen = new Set<string>();
	let cursor = 0;
	const chunks: string[] = [];
	for (const reference of parseImageReferences(brief)) {
		chunks.push(brief.slice(cursor, reference.start));
		if (!seen.has(reference.hash)) chunks.push(brief.slice(reference.start, reference.end));
		seen.add(reference.hash);
		cursor = reference.end;
	}
	chunks.push(brief.slice(cursor));
	brief = chunks.join("");
	const appearance = cast.filter((participant) => participant.sendAppearanceImages && castNameMatches(brief, participant.name))
		.flatMap((participant) => parseImageReferences(participant.prompt.appearance));
	const appended = [...appearance, ...kept].flatMap(({ name, hash }) => {
		if (seen.has(hash)) return [];
		seen.add(hash);
		return [formatImageReference(name, hash)];
	});
	return [brief, ...appended].filter(Boolean).join("\n\n");
};

export const illustrationName = (ask: string): string => ask.trim() ? sanitizeImageName(projectImageAnchors(ask).trim().split(/\s+/).slice(0, 6).join(" ")) : "Illustration";
