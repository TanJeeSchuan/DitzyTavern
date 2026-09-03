import { useReducer } from "react";
import { discardStagedImport } from "../import-chat";
import { ImportChatPanel } from "../ImportChatPanel";
import {
	createChatImportFlowState,
	reduceChatImportFlow,
} from "../import-chat-flow";

export function ImportChatSurface({
	characters,
	onImportLaunched,
	onClose,
}: {
	characters: { id: number; name: string }[];
	onImportLaunched: (conversationId: number) => void;
	onClose: () => void;
}) {
	const [flow, dispatch] = useReducer(
		reduceChatImportFlow,
		undefined,
		createChatImportFlowState,
	);

	const close = () => {
		discardStagedImport(flow.handle?.token ?? null);
		dispatch({ type: "reset" });
		onClose();
	};

	return (
		<aside className="details-panel" data-open="true">
			<ImportChatPanel
				flow={flow}
				onDispatch={dispatch}
				characters={characters}
				onImportLaunched={onImportLaunched}
				onBackToList={close}
				onClose={close}
			/>
		</aside>
	);
}
