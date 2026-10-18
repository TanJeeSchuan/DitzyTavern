import "./client.css";
import { useQuery } from "@tanstack/react-query";
import { MessageCircleDashed } from "lucide-react";
import { createBoxLens, api, foundOrNull, notFoundOutcome, requestOutcome, type BoxClientDefinition, type ConversationSummary } from "@/box-sdk/client";
import { stripThoughts, thoughtRead } from "./shared";
import descriptor from "./shared-descriptor";

const useThoughts = (conversation: ConversationSummary) => useQuery({
	queryKey: ["thought", conversation.id, conversation.revision],
	queryFn: async ({ signal }) => foundOrNull(await requestOutcome(
		api.api.conversations({ id: conversation.id }).boxes({ box: "thought" }).get({ fetch: { signal } }), thoughtRead, notFoundOutcome,
	)),
	placeholderData: (previous) => previous,
});

function ThoughtStatus({ conversation }: { conversation: ConversationSummary }) {
	const read = useThoughts(conversation);
	const count = read.data?.thoughts.length ?? 0;
	return <span>{read.isError ? "Unavailable" : count === 0 ? "No thoughts" : count === 1 ? "1 thought" : `${count} thoughts`}</span>;
}

/** @approved A thought the lens lifted out of the prose: the story keeps a mark where it was, which opens the Thoughts window. */
function ThoughtLensView({ onOpen }: { onOpen: () => void }) {
	return <button type="button" className="thought-mark" onClick={onOpen}>
		<MessageCircleDashed aria-hidden="true" />A thought
	</button>;
}

function ThoughtPanel({ conversation }: { conversation: ConversationSummary }) {
	const read = useThoughts(conversation);
	if (read.isError) return <p className="thought-note">The Thoughts could not be loaded.</p>;
	if (read.data === undefined || read.data === null) return null;
	if (read.data.thoughts.length === 0) return <p className="thought-note">No thoughts on this path yet.</p>;
	return <ol className="thought-list" aria-label="Thoughts">
		{read.data.thoughts.map(({ key, author, text }) => <li key={key} className="thought-item">
			{author !== null && <strong className="thought-author">{author}</strong>}{text}
		</li>)}
	</ol>;
}

const thoughtLens = createBoxLens("thought", () => true, stripThoughts, ThoughtLensView);

export default { descriptor, icon: MessageCircleDashed, Status: ThoughtStatus, Window: { size: { width: 22, height: 30 }, Panel: ThoughtPanel, lens: thoughtLens } } satisfies BoxClientDefinition;
