import { CheckCircle2, Download, FileArchive, GitFork, TriangleAlert, Unlink } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { downloadExactSource, loadImportDetails, type ChatImportDetails, type ChatSourceDownloadOutcome } from "./chat-history";
import { foundOrNull } from "./lib/request-outcome";
import { downloadFileInBrowser } from "./lib/download";
import { ImportWarningsList } from "./import-chat/ImportNotices";
import { formatSize } from "./lib/format";
import { PanelHeader } from "./PanelHeader";
import { ChatBackgroundSetting } from "./ChatBackground";
import type { ConversationSummary } from "./conversation";

// @approved
//  Keep import origin in this on-demand panel. Do not add an Imported badge,
// category, or capability mode. Load artifact bytes only for a download.

interface ChatInformationPanelProps {
	conversationId: number;
	chatTitle: string;
	conversation: ConversationSummary | null;
	onConversationChange: (conversation: ConversationSummary) => void;
	onOpenForkSource: () => void;
	onUnlinkFork: () => void;
	onClose: () => void;
}

export function ChatInformationPanel({
	conversationId,
	chatTitle,
	conversation,
	onConversationChange,
	onOpenForkSource,
	onUnlinkFork,
	onClose,
}: ChatInformationPanelProps) {
	const details = useQuery({
		queryKey: ["import-details", conversationId],
		queryFn: async ({ signal }) => foundOrNull(await loadImportDetails(conversationId, signal)),
		retry: false,
		refetchOnReconnect: false,
		refetchOnWindowFocus: false,
	});
	const download = useMutation({ mutationFn: () => downloadExactSource(conversationId) });

	const runDownload = () => download.mutate(undefined, {
		onSuccess: (outcome) => {
			if (outcome.outcome === "available") downloadFileInBrowser(outcome.filename, outcome.mediaType, outcome.bytes);
		},
	});

	return (
		<aside className="details-panel" data-open="true">
			<PanelHeader title="Chat information" onClose={onClose} />
			<div className="panel-body chat-info-body">
				<dl className="detail-list">
					<div>
						<dt>Chat</dt>
						<dd>{chatTitle}</dd>
					</div>
					<div>
						<dt>Chat ID</dt>
						<dd>{conversationId}</dd>
					</div>
				</dl>

				{conversation?.forkedFrom && <div className="chat-fork-origin">
					<button type="button" className="chat-fork-source" onClick={onOpenForkSource}>
						<GitFork aria-hidden="true" />
						<span>Forked from <strong>{conversation.forkedFrom.name}</strong></span>
					</button>
					<button type="button" className="icon-button" onClick={onUnlinkFork} aria-label="Remove Fork link" title="Remove Fork link"><Unlink aria-hidden="true" /></button>
				</div>}

				{conversation !== null && <ChatBackgroundSetting conversation={conversation} onConversationChange={onConversationChange} />}

				{details.isPending && (
					<p className="panel-note" role="status">
						Loading Chat information…
					</p>
				)}

				{details.data === null && (
					<>
						<p className="panel-note">
							This Chat was created in DitzyTavern.
						</p>
					</>
				)}

				{details.data?.provenanceState === "unreadable" && (
					<p className="import-problem" role="alert">
						Import provenance could not be read. You can still read and edit
						this Chat, but Import Details are unavailable.
					</p>
				)}

				{details.isError && (
					<p className="import-problem" role="alert">
						Chat information could not be loaded. Close and reopen this panel
						to try again.
					</p>
				)}

				{details.data?.provenanceState === "readable" && (
					<ImportDetailsSection
						details={details.data}
						downloading={download.isPending}
						downloadOutcome={download.data}
						onDownload={runDownload}
					/>
				)}
			</div>
		</aside>
	);
}

function ImportDetailsSection({
	details,
	downloading,
	downloadOutcome,
	onDownload,
}: {
	details: Extract<ChatImportDetails, { provenanceState: "readable" }>;
	downloading: boolean;
	downloadOutcome: ChatSourceDownloadOutcome | undefined;
	onDownload: () => void;
}) {
	const availability = details.artifact?.availability.status;
	const duplicates = [...details.duplicates.exact, ...details.duplicates.related];

	return (
		<section className="import-details-section">
			<header className="import-details-heading">
				<FileArchive aria-hidden="true" />
				<h3>Import Details</h3>
			</header>

			<dl className="detail-list import-meta-list">
				<div>
					<dt>Original filename</dt>
					<dd>{details.receipt.originalFilename}</dd>
				</div>
				<div>
					<dt>SHA-256</dt>
					<dd className="import-sha">{details.receipt.sha256}</dd>
				</div>
				<div>
					<dt>Size</dt>
					<dd>{formatSize(details.receipt.byteLength, "n/a")}</dd>
				</div>
				{details.receipt.integrity !== null && (
					<div>
						<dt>Declared integrity</dt>
						<dd className="import-sha">{details.receipt.integrity}</dd>
					</div>
				)}
				<div>
					<dt>Messages</dt>
					<dd>{details.receipt.counts.messages}</dd>
				</div>
				<div>
					<dt>Variants</dt>
					<dd>{details.receipt.counts.variants}</dd>
				</div>
				<div>
					<dt>Importer version</dt>
					<dd>{details.receipt.importerVersion}</dd>
				</div>
			</dl>

			{duplicates.length > 0 && (
				<div className="import-details-duplicates">
					<TriangleAlert aria-hidden="true" />
					<span>
						{details.duplicates.exact.length > 0
							? `This exact file was also imported as ${details.duplicates.exact.map((match) => `Chat ${match.id}`).join(", ")}.`
							: ""}
						{details.duplicates.exact.length > 0 && details.duplicates.related.length > 0 ? " " : ""}
						{details.duplicates.related.length > 0
							? `A related import with the same declared integrity was imported as ${details.duplicates.related.map((match) => `Chat ${match.id}`).join(", ")}.`
							: ""}
						{" "}This import remains a separate Chat.
					</span>
				</div>
			)}

			<ImportWarningsList warnings={details.receipt.warnings} />

			<div className="import-details-artifact">
				<h3>Preserved source</h3>
				{availability === "available" && (
					<div className="import-details-available">
						<CheckCircle2 aria-hidden="true" />
						<span>The original file is present and matches its recorded checksum.</span>
					</div>
				)}
				{availability === "cleaned-up" && (
					<div className="import-details-cleaned" role="alert">
						<TriangleAlert aria-hidden="true" />
						<span>
							The original file is missing or no longer matches its recorded
							checksum. You can still read and edit this Chat, but you cannot
							download the original file.
						</span>
					</div>
				)}
				<button
					className="secondary-button"
					type="button"
					disabled={availability !== "available" || downloading}
					onClick={onDownload}
				>
					<Download aria-hidden="true" />
					{downloading
						? "Preparing download…"
						: "Download original file"}
				</button>
				{downloadOutcome?.outcome === "cleaned-up" && (
					<p className="import-problem" role="alert">
						The original file is missing or no longer matches its recorded
						checksum. You can still read and edit this Chat, but you cannot
						download the original file.
					</p>
				)}
				{downloadOutcome?.outcome === "network" && (
					<p className="import-problem" role="alert">
						The download could not be prepared. Check the connection and
						try again.
					</p>
				)}
			</div>

		</section>
	);
}
