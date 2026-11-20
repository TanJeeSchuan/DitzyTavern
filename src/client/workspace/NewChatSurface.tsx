import { NewChatPanel } from "../NewChatPanel";
import { PanelHeader } from "../PanelHeader";

export function NewChatSurface({
	beforeCreate = (create) => create(),
	onCreated,
	onClose,
}: {
	beforeCreate?: (create: () => void) => void;
	onCreated: (conversationId: number) => void;
	onClose: () => void;
}) {
	return (
		<aside className="details-panel" data-open="true">
			<PanelHeader title="New Chat" onClose={onClose} />
			<NewChatPanel beforeCreate={beforeCreate} onCreated={onCreated} />
		</aside>
	);
}

