import type { CanonicalGenerationSettings } from "../../shared/contract/generation-settings";
import { imageAnchor, parseImageReferences } from "../../shared/image-reference";
import type { PromptImage, PromptPlan, PromptWarning } from "./types";

export type RepeatedImagePlacement = CanonicalGenerationSettings["repeatedImagePlacement"];

export interface ImageDimensions {
	readonly width: number;
	readonly height: number;
}

export type ImageLookup = (hash: string) => ImageDimensions | undefined;

interface BoxImageGrant { readonly label: string; readonly hashes: ReadonlySet<string> }
export type BoxImageGrants = ReadonlyMap<string, BoxImageGrant>;

export const guardBoxPromptImages = (text: string, grant: BoxImageGrant | undefined, warnings: PromptWarning[]): string => {
	if (grant === undefined) return text;
	for (const { hash, name, start, end } of parseImageReferences(text).reverse()) {
		if (grant.hashes.has(hash)) continue;
		warnings.push({ block: `${grant.label} Box`, macro: name, reason: "ungranted-image" });
		text = text.slice(0, start) + imageAnchor(name) + text.slice(end);
	}
	return text;
};

export interface PromptImageResolution {
	readonly boxGrants?: BoxImageGrants;
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
	{ lookup, placement, sendImages, boxGrants }: PromptImageResolution,
): PromptPlan => {
	const warnings = [...plan.warnings];
	const blocks = plan.blocks.map((block) => ({ ...block, content: guardBoxPromptImages(block.content, boxGrants?.get(block.kind), warnings) }));
	const occurrences = blocks.flatMap(({ content }, block) =>
		parseImageReferences(content).map(({ start, hash, name }) => ({ block, start, hash, name, dimensions: lookup(hash) })));
	const chosen = new Map<string, number>();
	occurrences.forEach(({ hash, dimensions }, index) => {
		if (dimensions !== undefined && (placement === "last" || !chosen.has(hash))) chosen.set(hash, index);
	});
	return {
		...plan, blocks, warnings,
		images: occurrences.map(({ dimensions, ...occurrence }, index): PromptImage => {
			if (dimensions === undefined) return { ...occurrence, disposition: "missing", tokens: 0 };
			if (!sendImages) return { ...occurrence, disposition: "text-only", tokens: 0 };
			return { ...occurrence, disposition: placement === "every" || chosen.get(occurrence.hash) === index ? "send" : "anchor", tokens: imageTokenCost(dimensions) };
		}),
	};
};

export const sentImageTokens = (images: readonly PromptImage[]): number =>
	images.reduce((total, image) => total + (image.disposition === "send" ? image.tokens : 0), 0);
