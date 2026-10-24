import type { TSchema } from "@sinclair/typebox";
import { useQuery } from "@tanstack/react-query";
import type { BoxId } from "../../shared/contract/box";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import type { ConversationSummary } from "../conversation";
import { api } from "../lib/eden";
import { foundOrNull, requestOutcome } from "../lib/request-outcome";

// @approved
//  A Box's window read, decoded with the Box's own schema. The key carries
// the Chat's revision, so the read refetches when the Chat changes, and the
// previous read stays as placeholder data meanwhile, so a window keeps what
// it shows, such as the Race's markers, through the refetch. A missing Chat
// reads as null.
export const useBoxRead = <Schema extends TSchema>(conversation: ConversationSummary, box: BoxId, schema: Schema) => useQuery({
	queryKey: [box, conversation.id, conversation.revision],
	queryFn: async ({ signal }) => foundOrNull(await requestOutcome(api.api.conversations({ id: conversation.id }).boxes({ box }).get({ fetch: { signal } }), schema, notFoundOutcome)),
	placeholderData: (previous) => previous,
});
