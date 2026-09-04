import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
	type Workspace,
	workspaceClient,
} from "./workspace";
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
	| { status: "ready"; workspace: Workspace }
	| { status: "error" };

const hasActiveChat = (
	workspace: Workspace,
): workspace is Workspace & { activeChat: NonNullable<Workspace["activeChat"]> } =>
	workspace.activeChat !== null;

export function App() {
	const [state, setState] = useState<WorkspaceState>({ status: "loading" });

	const loadWorkspace = useCallback(async (preferredChatId?: string) => {
		setState({ status: "loading" });
		try {
			const workspace = await workspaceClient.loadActiveWorkspace(preferredChatId);
			setState({ status: "ready", workspace });
		} catch {
			setState({ status: "error" });
		}
	}, []);

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
			initialWorkspace={state.workspace}
			onReload={loadWorkspace}
			onImportLaunched={(conversationId) =>
				void handleImportLaunched(conversationId)
			}
		/>
	);
}

function WritingWorkspace({
	initialWorkspace,
	onReload,
	onImportLaunched,
}: {
	initialWorkspace: Workspace;
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

	if (!hasActiveChat(initialWorkspace)) {
		return (
			<>
				<WorkspaceWithoutChats
					onNewChat={() => setNewChatOpen(true)}
					onImportChat={() => setImportChatOpen(true)}
					onOpenSettings={() => setConnectionSettingsOpen(true)}
				/>
				{connectionSettingsOpen && (
					<div className="empty-settings-layer">
						<section className="empty-settings-panel" aria-label="Connection Settings">
							<header>
								<h2>Connection Settings</h2>
								<button
									className="icon-button"
									type="button"
									aria-label="Close Connection Settings"
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
							characters={initialWorkspace.characters}
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
				key={initialWorkspace.activeChat.id}
				initialWorkspace={initialWorkspace}
				onNewChat={() => setNewChatOpen(true)}
				newChatOpen={newChatOpen}
				onNewChatClose={() => setNewChatOpen(false)}
				onNewChatCreated={() => void handleCreated()}
				onImportLaunched={onImportLaunched}
			/>
		</>
	);
}
