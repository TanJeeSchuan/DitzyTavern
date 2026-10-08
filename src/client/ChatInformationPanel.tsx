import { CheckCircle2, Download, FileArchive, TriangleAlert } from "lucide-react";
import { useReducer, useState } from "react";
import {
	artifactAvailabilityLabel,
	createChatInformationState,
	reduceChatInformation,
	sourceDownloadAvailable,
	type ChatInformationState,
} from "./chat-info";
import {
	downloadExactSource,
	loadImportDetails,
	type ChatSourceDownloadOutcome,
} from "./chat-history";
import { downloadFileInBrowser } from "./lib/download";
import { ImportWarningsList } from "./import-chat/ImportNotices";
import { useAsyncEffect } from "./lib/use-async";
import { formatSize } from "./lib/format";
import { PanelHeader } from "./PanelHeader";

// @approved
//  Keep import origin in this on-demand panel. Do not add an Imported badge,
// category, or capability mode. Load artifact bytes only for a download.

interface ChatInformationPanelProps {
	conversationId: number;
	chatTitle: string;
	onClose: () => void;
}

export function ChatInformationPanel({
	conversationId,
	chatTitle,
	onClose,
}: ChatInformationPanelProps) {
	const [state, dispatch] = useReducer(
		reduceChatInformation,
		undefined,
		createChatInformationState,
	);
	const [downloadOutcome, setDownloadOutcome] = useState<
		{ outcome: "idle" } | { outcome: "downloading" } | ChatSourceDownloadOutcome
	>({ outcome: "idle" });

	useAsyncEffect((isCancelled) => {
		dispatch({ type: "chat-opened" });
		void loadImportDetails(conversationId).then((outcome) => {
			if (isCancelled()) return;
			if (outcome.outcome === "available") {
				if (outcome.value.provenanceState === "unreadable") {
					dispatch({ type: "details-unreadable" });
					return;
				}
				dispatch({ type: "details-loaded", details: outcome.value });
				return;
			}
			if (outcome.outcome === "not-found") {
				dispatch({ type: "no-import-details" });
				return;
			}
			dispatch({ type: "details-failed" });
		});
	}, [conversationId]);

	const runDownload = async () => {
		const download = sourceDownloadAvailable(state);
		if (!download.available) return;
		setDownloadOutcome({ outcome: "downloading" });
		const outcome = await downloadExactSource(conversationId);
		if (outcome.outcome === "available") {
			downloadFileInBrowser(outcome.filename, outcome.mediaType, outcome.bytes);
		}
		setDownloadOutcome(outcome);
	};

	const availability = artifactAvailabilityLabel(state);
	const download = sourceDownloadAvailable(state);

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

				{state.status === "loading" && (
					<p className="panel-note" role="status">
						Loading Chat information…
					</p>
				)}

				{state.status === "no-import-details" && (
					<>
						<p className="panel-note">
							This Chat was created in DitzyTavern.
						</p>
					</>
				)}

				{state.status === "unreadable-import-details" && (
					<p className="import-problem" role="alert">
						Import provenance could not be read. You can still read and edit
						this Chat, but Import Details are unavailable.
					</p>
				)}

				{state.status === "error" && (
					<p className="import-problem" role="alert">
						Chat information could not be loaded. Close and reopen this panel
						to try again.
					</p>
				)}

				{state.status === "available" && (
					<ImportDetailsSection
						state={state}
						availability={availability}
						download={download}
						downloadOutcome={downloadOutcome}
						onDownload={() => void runDownload()}
					/>
				)}
			</div>
		</aside>
	);
}

function ImportDetailsSection({
	state,
	availability,
	download,
	downloadOutcome,
	onDownload,
}: {
	state: Extract<ChatInformationState, { status: "available" }>;
	availability: ReturnType<typeof artifactAvailabilityLabel>;
	download: ReturnType<typeof sourceDownloadAvailable>;
	downloadOutcome: { outcome: "idle" } | { outcome: "downloading" } | ChatSourceDownloadOutcome;
	onDownload: () => void;
}) {
	const { details } = state;
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
				{availability !== null && availability.status === "available" && (
					<div className="import-details-available">
						<CheckCircle2 aria-hidden="true" />
						<span>The original file is present and matches its recorded checksum.</span>
					</div>
				)}
				{availability !== null && availability.status === "cleaned-up" && (
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
					disabled={
						!download.available ||
						downloadOutcome.outcome === "downloading"
					}
					onClick={onDownload}
				>
					<Download aria-hidden="true" />
					{downloadOutcome.outcome === "downloading"
						? "Preparing download…"
						: "Download original file"}
				</button>
				{downloadOutcome.outcome === "cleaned-up" && (
					<p className="import-problem" role="alert">
						The original file is missing or no longer matches its recorded
						checksum. You can still read and edit this Chat, but you cannot
						download the original file.
					</p>
				)}
				{downloadOutcome.outcome === "network" && (
					<p className="import-problem" role="alert">
						The download could not be prepared. Check the connection and
						try again.
					</p>
				)}
			</div>

		</section>
	);
}
