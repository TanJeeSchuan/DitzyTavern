import type { ConversationSummary } from "../conversation";
import { BoxIcon } from "./BoxBoundary";
import { boxClients, boxPresent } from "./registry";

export function BoxMessageActions({ conversation, messageId, onOpen }: {
	conversation: ConversationSummary;
	messageId: number;
	onOpen: (box: string, focus: { messageId: number }) => void;
}) {
	return boxClients().map(([id, { icon, Inspector }]) => Inspector && boxPresent(conversation, id) && (
		<button key={id} className="edit-action" type="button" onClick={() => onOpen(id, { messageId })}>
			<BoxIcon box={id} icon={icon} /> {Inspector.label}
		</button>
	));
}
