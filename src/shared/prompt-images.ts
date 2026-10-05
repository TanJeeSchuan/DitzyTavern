import type { PromptImage } from "./contract/conversation-schema";
import type { CanonicalGenerationSettings } from "./contract/generation-settings";
import { parseImageReferences } from "./image-reference";

export type RepeatedImagePlacement = CanonicalGenerationSettings["repeatedImagePlacement"];

export type ImageCostLookup = (hash: string) => { readonly tokens: number } | undefined;

export const resolveImageReferences = (
	texts: readonly string[],
	lookup: ImageCostLookup,
	placement: RepeatedImagePlacement,
): PromptImage[] => {
	const occurrences = texts.flatMap((text, block) =>
		parseImageReferences(text).map(({ start, hash, name }) => ({ block, start, hash, name, cost: lookup(hash) })));
	const chosen = new Map<string, number>();
	occurrences.forEach(({ hash, cost }, index) => {
		if (cost !== undefined && (placement === "last" || !chosen.has(hash))) chosen.set(hash, index);
	});
	return occurrences.map(({ cost, ...occurrence }, index): PromptImage => {
		if (cost === undefined) return { ...occurrence, disposition: "missing", tokens: 0 };
		return { ...occurrence, disposition: placement === "every" || chosen.get(occurrence.hash) === index ? "send" : "anchor", tokens: cost.tokens };
	});
};

export const sentImageTokens = (images: readonly PromptImage[]): number =>
	images.reduce((total, image) => total + (image.disposition === "send" ? image.tokens : 0), 0);
