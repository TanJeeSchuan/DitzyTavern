import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { loadActiveChatId } from "./workspace";
import { ActiveWritingWorkspace } from "./workspace/ActiveWritingWorkspace";
import { ConnectionSettingsPanelHost } from "./workspace/ConnectionSettingsPanel";
import { NewChatSurface } from "./workspace/NewChatSurface";
import { ImportChatSurface } from "./import-chat/ImportChatSurface";
import {
	WorkspaceError,
	WorkspaceLoading,
	WorkspaceWithoutChats,
} from "./workspace/WorkspaceStatus";

type WorkspaceState =
	| { status: "loading" }
	| { status: "ready"; activeChatId: string | null }
	| { status: "error" };

export function App() {
	const client = useQueryClient();
	const [state, setState] = useState<WorkspaceState>({ status: "loading" });

	const loadWorkspace = useCallback(async (preferredChatId?: string) => {
		setState({ status: "loading" });
		try {
			const activeChatId = await loadActiveChatId(client, preferredChatId);
			setState({ status: "ready", activeChatId });
		} catch {
			setState({ status: "error" });
		}
	}, [client]);

	const handleImportLaunched = useCallback(
		async (conversationId: number) => {
			await loadWorkspace(String(conversationId));
		},
		[loadWorkspace],
	);

	useEffect(() => {
		void loadWorkspace();
	}, [loadWorkspace]);

	if (state.status === "loading") {
		return <WorkspaceLoading />;
	}

	if (state.status === "error") {
		return <WorkspaceError onRetry={() => void loadWorkspace()} />;
	}

	return (
		<WritingWorkspace
			initialChatId={state.activeChatId}
			onReload={loadWorkspace}
			onImportLaunched={(conversationId) =>
				void handleImportLaunched(conversationId)
			}
		/>
	);
}

function WritingWorkspace({
	initialChatId,
	onReload,
	onImportLaunched,
}: {
	initialChatId: string | null;
	onReload: () => Promise<void>;
	onImportLaunched: (conversationId: number) => void;
}) {
	const [newChatOpen, setNewChatOpen] = useState(false);
	const [importChatOpen, setImportChatOpen] = useState(false);
	const [connectionSettingsOpen, setConnectionSettingsOpen] = useState(false);

	const handleCreated = async () => {
		setNewChatOpen(false);
		await onReload();
	};

	if (initialChatId === null) {
		return (
			<>
				<WorkspaceWithoutChats
					onNewChat={() => setNewChatOpen(true)}
					onImportChat={() => setImportChatOpen(true)}
					onOpenSettings={() => setConnectionSettingsOpen(true)}
				/>
				{connectionSettingsOpen && (
					<div className="empty-settings-layer">
						<section className="empty-settings-panel" aria-label="Connections">
							<header>
								<h2>Connections</h2>
								<button
									className="icon-button"
									type="button"
									aria-label="Close Connections"
									onClick={() => setConnectionSettingsOpen(false)}
								>
									×
								</button>
							</header>
							<ConnectionSettingsPanelHost />
						</section>
					</div>
				)}
				{newChatOpen && (
					createPortal(
						<NewChatSurface
							onCreated={() => void handleCreated()}
							onClose={() => setNewChatOpen(false)}
						/>,
						document.body,
					)
				)}
				{importChatOpen && (
					createPortal(
						<ImportChatSurface
							onImportLaunched={onImportLaunched}
							onClose={() => setImportChatOpen(false)}
						/>,
						document.body,
					)
				)}
			</>
		);
	}

	return (
		<>
			<ActiveWritingWorkspace
				key={initialChatId}
				initialChatId={initialChatId}
				onNewChat={() => setNewChatOpen(true)}
				newChatOpen={newChatOpen}
				onNewChatClose={() => setNewChatOpen(false)}
				onNewChatCreated={() => void handleCreated()}
				onImportLaunched={onImportLaunched}
				onReload={() => void onReload()}
			/>
		</>
	);
}
