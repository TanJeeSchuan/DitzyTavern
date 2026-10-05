import { resolveImageReferences, type RepeatedImagePlacement } from "../../shared/prompt-images";
import type { PromptPlan } from "./types";

export interface ImageDimensions {
	readonly width: number;
	readonly height: number;
}

export type ImageLookup = (hash: string) => ImageDimensions | undefined;

export interface PromptImageResolution {
	readonly lookup: ImageLookup;
	readonly placement: RepeatedImagePlacement;
}

const FIT_LONG_EDGE = 1568;
const PIXELS_PER_TOKEN = 750;

export const imageTokenCost = ({ width, height }: ImageDimensions): number => {
	const scale = Math.min(1, FIT_LONG_EDGE / Math.max(width, height));
	return Math.ceil((width * scale * height * scale) / PIXELS_PER_TOKEN);
};

export const resolvePromptImages = (
	plan: Omit<PromptPlan, "images">,
	{ lookup, placement }: PromptImageResolution,
): PromptPlan => ({
	...plan,
	images: resolveImageReferences(plan.blocks.map((block) => block.content), (hash) => {
		const dimensions = lookup(hash);
		return dimensions === undefined ? undefined : { tokens: imageTokenCost(dimensions) };
	}, placement),
});
