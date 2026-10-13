import type { ConversationSummary } from "../conversation";
import { boxClients } from "./registry";

export function BoxMessageActions({ conversation, messageId, onOpen }: {
	conversation: ConversationSummary;
	messageId: number;
	onOpen: (box: string, focus: { messageId: number }) => void;
}) {
	return [...boxClients()].map(([id, { icon: Icon, Inspector }]) => Inspector && conversation.boxes[id] === "enabled" && (
		<button key={id} className="edit-action" type="button" onClick={() => onOpen(id, { messageId })}>
			<Icon aria-hidden="true" /> {Inspector.label}
		</button>
	));
}
