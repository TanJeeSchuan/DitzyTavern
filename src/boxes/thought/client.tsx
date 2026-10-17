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

function ThoughtDockTab({ conversation, onRestore }: { conversation: ConversationSummary; onRestore: () => void }) {
	const read = useThoughts(conversation);
	const count = read.data?.thoughts.length ?? 0;
	return <button type="button" className="box-dock-tab" title="Restore Thoughts" onClick={onRestore}>
		<MessageCircleDashed aria-hidden="true" /><span className="thought-label">Thoughts: </span>
		<span>{read.isError ? "Unavailable" : count === 0 ? "No thoughts" : count === 1 ? "1 thought" : `${count} thoughts`}</span>
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

const thoughtLens = createBoxLens("thought", () => true, stripThoughts, (run) => run.length === 1 ? "A thought" : `${run.length} thoughts`);

export default { descriptor, icon: MessageCircleDashed, Window: { size: { width: 22, height: 30 }, DockTab: ThoughtDockTab, Panel: ThoughtPanel, lens: thoughtLens } } satisfies BoxClientDefinition;
