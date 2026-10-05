const MAX_NAME_LENGTH = 80;
const REFERENCE = /!\[([^[\]\\\r\n]+)\]\(image:([0-9a-f]{64})\)/g;
const REFERENCE_HERE = new RegExp(REFERENCE.source, "y");

export interface ImageReference {
	name: string;
	hash: string;
	start: number;
	end: number;
}

const toReference = (match: RegExpMatchArray): ImageReference => {
	const start = match.index ?? 0;
	return { name: match[1]!, hash: match[2]!, start, end: start + match[0].length };
};

export const parseImageReferences = (text: string): ImageReference[] => [...text.matchAll(REFERENCE)].map(toReference);

export const imageReferenceAt = (text: string, position: number): ImageReference | undefined => {
	REFERENCE_HERE.lastIndex = position;
	const match = REFERENCE_HERE.exec(text);
	return match === null ? undefined : toReference(match);
};

export const sanitizeImageName = (name: string): string =>
	name.replace(/[[\]\\\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH).trim() || "image";

export const formatImageReference = (name: string, hash: string): string =>
	`![${sanitizeImageName(name)}](image:${hash})`;

export const imageAnchor = (name: string): string => `[Image: ${name}]`;

export const projectImageAnchors = (text: string): string =>
	text.replace(REFERENCE, (_match, name: string) => imageAnchor(name));
