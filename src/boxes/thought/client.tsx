import { createBoxLens } from "@/box-sdk/client";
import { stripThoughts } from "./shared";
import { useQuery } from "@tanstack/react-query";
import { MessageCircleDashed } from "lucide-react";
import { api, foundOrNull, notFoundOutcome, requestOutcome, type ConversationSummary } from "@/box-sdk/client";
import { thoughtRead } from "./shared";

const useThoughts = (conversation: ConversationSummary) => useQuery({
	queryKey: ["thought", conversation.id, conversation.revision],
	queryFn: async ({ signal }) => foundOrNull(await requestOutcome(
		api.api.conversations({ id: conversation.id }).boxes({ box: "thought" }).get({ fetch: { signal } }), thoughtRead, notFoundOutcome,
	)),
	placeholderData: (previous) => previous,
});

export function ThoughtDockTab({ conversation, onRestore }: { conversation: ConversationSummary; onRestore: () => void }) {
	const read = useThoughts(conversation);
	const count = read.data?.thoughts.length ?? 0;
	return <button type="button" className="box-dock-tab" title="Restore Thoughts" onClick={onRestore}>
		<MessageCircleDashed aria-hidden="true" /><span className="sr-only">Thoughts: </span>
		<span>{read.isError ? "Unavailable" : count === 0 ? "No thoughts" : count === 1 ? "1 thought" : `${count} thoughts`}</span>
	</button>;
}

/** @approved A thought the lens lifted out of the prose: the story keeps a mark where it was, which opens the Thoughts window. */
export function ThoughtLensView({ onOpen }: { onOpen: () => void }) {
	return <button type="button" className="mt-1 mb-3 inline-flex items-center gap-1.5 text-[0.8rem] text-muted-foreground hover:text-foreground [&_svg]:size-3.5" onClick={onOpen}>
		<MessageCircleDashed aria-hidden="true" />A thought
	</button>;
}

export function ThoughtPanel({ conversation }: { conversation: ConversationSummary }) {
	const read = useThoughts(conversation);
	if (read.isError) return <p className="text-[0.8rem] text-muted-foreground">The Thoughts could not be loaded.</p>;
	if (read.data === undefined || read.data === null) return null;
	if (read.data.thoughts.length === 0) return <p className="text-[0.8rem] text-muted-foreground">No thoughts on this path yet.</p>;
	return <ol className="grid gap-2" aria-label="Thoughts">
		{read.data.thoughts.map(({ key, author, text }) => <li key={key} className="grid gap-0.5 rounded-xl bg-muted px-2.5 py-2 font-(family-name:--font-reading) italic whitespace-pre-wrap">
			{author !== null && <strong className="font-sans text-xs font-semibold not-italic text-muted-foreground">{author}</strong>}{text}
		</li>)}
	</ol>;
}

export const thoughtLens = createBoxLens("thought", () => true, stripThoughts, ThoughtLensView);
