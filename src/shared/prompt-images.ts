import type { PromptImage } from "./contract/conversation-schema";
import type { CanonicalGenerationSettings } from "./contract/generation-settings";
import { parseImageReferences } from "./image-reference";

export type RepeatedImagePlacement = CanonicalGenerationSettings["repeatedImagePlacement"];

export type ImageCostLookup<Tokens extends number | undefined = number> = (hash: string) => { readonly tokens: Tokens } | undefined;

export const resolveImageReferences = <Tokens extends number | undefined>(
	texts: readonly string[],
	lookup: ImageCostLookup<Tokens>,
	placement: RepeatedImagePlacement,
	sendImages: boolean,
): (Omit<PromptImage, "tokens"> & { tokens: Tokens | 0 })[] => {
	const occurrences = texts.flatMap((text, block) =>
		parseImageReferences(text).map(({ start, hash, name }) => ({ block, start, hash, name, cost: lookup(hash) })));
	const chosen = new Map<string, number>();
	occurrences.forEach(({ hash, cost }, index) => {
		if (cost !== undefined && (placement === "last" || !chosen.has(hash))) chosen.set(hash, index);
	});
	return occurrences.map(({ cost, ...occurrence }, index) => {
		if (cost === undefined) return { ...occurrence, disposition: "missing", tokens: 0 };
		if (!sendImages) return { ...occurrence, disposition: "text-only", tokens: 0 };
		return { ...occurrence, disposition: placement === "every" || chosen.get(occurrence.hash) === index ? "send" : "anchor", tokens: cost.tokens };
	});
};

export const sentImageTokens = (images: readonly PromptImage[]): number =>
	images.reduce((total, image) => total + (image.disposition === "send" ? image.tokens : 0), 0);
