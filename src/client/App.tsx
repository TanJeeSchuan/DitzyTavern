import { useCallback, useEffect, useState } from "react";
import {
	type Workspace,
	workspaceClient,
} from "./workspace";
import { ActiveWritingWorkspace } from "./workspace/ActiveWritingWorkspace";
import { ConnectionSettingsPanel } from "./workspace/ConnectionSettingsPanel";
import { NewChatSurface } from "./workspace/NewChatSurface";
import {
	WorkspaceError,
	WorkspaceLoading,
	WorkspaceWithoutChats,
} from "./workspace/WorkspaceStatus";

type WorkspaceState =
	| { status: "loading" }
	| { status: "ready"; workspace: Workspace }
	| { status: "error" };

export function App() {
	const [state, setState] = useState<WorkspaceState>({ status: "loading" });
	// ==[HUMAN APPROVED]== A just-imported Chat to open after the workspace reloads. It lives at
	// App level because reloading the workspace unmounts the whole tree, and
	// the selection must survive until the reloaded chat list contains it.
	const [importLaunchChatId, setImportLaunchChatId] = useState<string | null>(null);

	const loadWorkspace = useCallback(async () => {
		setState({ status: "loading" });
		try {
			const workspace = await workspaceClient.loadActiveWorkspace();
			setState({ status: "ready", workspace });
		} catch {
			setState({ status: "error" });
		}
	}, []);

	const handleImportLaunched = useCallback(
		async (conversationId: number) => {
			setImportLaunchChatId(String(conversationId));
			try {
				await loadWorkspace();
			} finally {
				// ==[HUMAN APPROVED]== Clears after the reloaded workspace rendered, so the selection
				// effect could observe the target in the refreshed chat list.
				window.setTimeout(() => setImportLaunchChatId(null), 0);
			}
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
			importLaunchChatId={importLaunchChatId}
			onImportLaunched={(conversationId) =>
				void handleImportLaunched(conversationId)
			}
		/>
	);
}

function WritingWorkspace({
	initialWorkspace,
	onReload,
	importLaunchChatId,
	onImportLaunched,
}: {
	initialWorkspace: Workspace;
	onReload: () => Promise<void>;
	importLaunchChatId: string | null;
	onImportLaunched: (conversationId: number) => void;
}) {
	const [newChatOpen, setNewChatOpen] = useState(false);
	const [connectionSettingsOpen, setConnectionSettingsOpen] = useState(false);

	const handleCreated = async () => {
		setNewChatOpen(false);
		await onReload();
	};

	if (!initialWorkspace.activeChat) {
		return (
			<>
				<WorkspaceWithoutChats
					onNewChat={() => setNewChatOpen(true)}
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
							<ConnectionSettingsPanel />
						</section>
					</div>
				)}
				{newChatOpen && (
					<NewChatSurface
						onCreated={() => void handleCreated()}
						onClose={() => setNewChatOpen(false)}
					/>
				)}
			</>
		);
	}

	return (
		<>
			<ActiveWritingWorkspace
				key={initialWorkspace.activeChat.id}
				initialWorkspace={{
					...initialWorkspace,
					activeChat: initialWorkspace.activeChat,
				}}
				onNewChat={() => setNewChatOpen(true)}
				newChatOpen={newChatOpen}
				onNewChatClose={() => setNewChatOpen(false)}
				onNewChatCreated={() => void handleCreated()}
				importLaunchChatId={importLaunchChatId}
				onImportLaunched={onImportLaunched}
			/>
		</>
	);
}
