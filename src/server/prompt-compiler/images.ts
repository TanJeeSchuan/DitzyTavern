import type { CanonicalGenerationSettings } from "../../shared/contract/generation-settings";
import { parseImageReferences } from "../../shared/image-reference";
import type { PromptImage, PromptPlan } from "./types";

export type RepeatedImagePlacement = CanonicalGenerationSettings["repeatedImagePlacement"];

export interface ImageDimensions {
	readonly width: number;
	readonly height: number;
}

export type ImageLookup = (hash: string) => ImageDimensions | undefined;

export interface PromptImageResolution {
	readonly lookup: ImageLookup;
	readonly placement: RepeatedImagePlacement;
	readonly sendImages: boolean;
}

const FIT_LONG_EDGE = 1568;
const PIXELS_PER_TOKEN = 750;

export const imageTokenCost = ({ width, height }: ImageDimensions): number => {
	const scale = Math.min(1, FIT_LONG_EDGE / Math.max(width, height));
	return Math.ceil((width * scale * height * scale) / PIXELS_PER_TOKEN);
};

export const resolvePromptImages = (
	plan: Omit<PromptPlan, "images">,
	{ lookup, placement, sendImages }: PromptImageResolution,
): PromptPlan => {
	const occurrences = plan.blocks.flatMap(({ content }, block) =>
		parseImageReferences(content).map(({ start, hash, name }) => ({ block, start, hash, name, dimensions: lookup(hash) })));
	const chosen = new Map<string, number>();
	occurrences.forEach(({ hash, dimensions }, index) => {
		if (dimensions !== undefined && (placement === "last" || !chosen.has(hash))) chosen.set(hash, index);
	});
	return {
		...plan,
		images: occurrences.map(({ dimensions, ...occurrence }, index): PromptImage => {
			if (dimensions === undefined) return { ...occurrence, disposition: "missing", tokens: 0 };
			if (!sendImages) return { ...occurrence, disposition: "text-only", tokens: 0 };
			return { ...occurrence, disposition: placement === "every" || chosen.get(occurrence.hash) === index ? "send" : "anchor", tokens: imageTokenCost(dimensions) };
		}),
	};
};

export const sentImageTokens = (images: readonly PromptImage[]): number =>
	images.reduce((total, image) => total + (image.disposition === "send" ? image.tokens : 0), 0);
