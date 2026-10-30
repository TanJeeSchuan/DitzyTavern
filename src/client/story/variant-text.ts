import { queryOptions, useQueries, useQuery, type QueryClient } from "@tanstack/react-query";
import { loadVariantText } from "../chat-history";
import type { StoryVariant } from "../story";

export const variantTextKey = (conversationId: number) => ["variant-text", conversationId] as const;

const variantTextQuery = (conversationId: number, messageId: number, variantId: number) => queryOptions({
	queryKey: [...variantTextKey(conversationId), variantId] as const,
	staleTime: Infinity,
	queryFn: ({ signal }) => loadVariantText(conversationId, messageId, variantId, signal),
});

const withText = (variant: StoryVariant, text: { content: string; reasoning: string } | undefined): StoryVariant =>
	text === undefined ? variant : { ...variant, content: variant.content ?? text.content, reasoning: variant.reasoning || text.reasoning };

/** @approved The Variant with its text: what the page carried, or else the Variant text read. `reasoning` asks for persisted Reasoning Content too. */
export function useVariantText(conversationId: number, messageId: number, variant: StoryVariant | undefined, { reasoning = false } = {}) {
	const needed = variant !== undefined && (variant.content === null || (reasoning && variant.hasReasoning && !variant.reasoning));
	const read = useQuery({ ...variantTextQuery(conversationId, messageId, variant?.id ?? 0), enabled: needed });
	return variant === undefined ? undefined : withText(variant, read.data);
}

/** @approved Every Variant of a Message with its Content, read while `enabled`, as the Swipes browser shows them all. */
export function useVariantsText(conversationId: number, messageId: number, variants: StoryVariant[], enabled: boolean) {
	const reads = useQueries({ queries: variants.map((variant) => ({ ...variantTextQuery(conversationId, messageId, variant.id), enabled: enabled && variant.content === null })) });
	return variants.map((variant, index) => withText(variant, reads[index]?.data));
}

/** @approved Starts reading the Swipes beside the shown one, so moving to one shows its text at once. */
export const prefetchNeighbourText = (client: QueryClient, conversationId: number, messageId: number, variants: StoryVariant[], shownIndex: number) => {
	for (const variant of [variants[shownIndex - 1], variants[shownIndex + 1]]) {
		if (variant !== undefined && variant.content === null) void client.prefetchQuery(variantTextQuery(conversationId, messageId, variant.id));
	}
};
