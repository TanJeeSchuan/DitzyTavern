import { NewChatPanel } from "../NewChatPanel";
import { PanelHeader } from "../PanelHeader";

export function NewChatSurface({
	onCreated,
	onClose,
}: {
	onCreated: (conversationId: number) => void;
	onClose: () => void;
}) {
	return (
		<aside className="details-panel" data-open="true">
			<PanelHeader title="New Chat" onClose={onClose} />
			<NewChatPanel onCreated={onCreated} />
		</aside>
	);
}

