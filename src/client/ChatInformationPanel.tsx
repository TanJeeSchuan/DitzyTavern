import { CheckCircle2, Download, FileArchive, TriangleAlert } from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import {
	artifactAvailabilityLabel,
	createChatInformationState,
	reduceChatInformation,
	sourceDownloadAvailable,
	type ChatInformationState,
} from "./chat-info";
import {
	chatHistoryTransport,
	downloadImportedSourceInBrowser,
	type ChatSourceDownloadOutcome,
} from "./chat-history";
import {
	applyConversationCommand,
	loadConversationGenerationSettings,
	type ConversationGenerationSettings,
	type ContinuationPrefillSuffix,
	type ConversationSummary,
} from "./conversation";
import { PanelHeader } from "./PanelHeader";

function continuationStrategyValue(
	value: string,
): ConversationGenerationSettings["continuationStrategy"] {
	return value === "assistant-prefill" ? value : "instruction";
}

function continuationPrefillSuffixValue(value: string): ContinuationPrefillSuffix {
	return value === " " || value === "\n" || value === "\n\n" ? value : "";
}

// Keep import origin in this on-demand panel. Do not add an Imported badge,
// category, or capability mode. Load artifact bytes only for a download.

interface ChatInformationPanelProps {
	conversationId: number;
	chatTitle: string;
	conversation?: ConversationSummary | null;
	onConversationChange?: (conversation: ConversationSummary) => void;
	onClose: () => void;
}

const formatSize = (byteLength: number | null): string => {
	if (byteLength === null) return "n/a";
	if (byteLength < 1024) return `${byteLength} B`;
	const kilobytes = byteLength / 1024;
	if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
	return `${(kilobytes / 1024).toFixed(1)} MB`;
};

export function ChatInformationPanel({
	conversationId,
	chatTitle,
	conversation = null,
	onConversationChange,
	onClose,
}: ChatInformationPanelProps) {
	const [state, dispatch] = useReducer(
		reduceChatInformation,
		undefined,
		createChatInformationState,
	);
	const [downloadOutcome, setDownloadOutcome] = useState<
		{ status: "idle" } | { status: "downloading" } | ChatSourceDownloadOutcome
	>({ status: "idle" });

	useEffect(() => {
		let cancelled = false;
		dispatch({ type: "chat-opened" });
		void chatHistoryTransport
			.loadImportDetails(conversationId)
			.then((outcome) => {
				if (cancelled) return;
				if (outcome.status === "available") {
					dispatch({ type: "details-loaded", details: outcome.details });
					return;
				}
				if (outcome.status === "not-found") {
					dispatch({ type: "no-import-details" });
					return;
				}
				dispatch({ type: "details-failed" });
			});
		return () => {
			cancelled = true;
		};
	}, [conversationId]);

	const runDownload = async () => {
		const download = sourceDownloadAvailable(state);
		if (!download.available) return;
		setDownloadOutcome({ status: "downloading" });
		const outcome = await chatHistoryTransport.downloadExactSource(conversationId);
		if (outcome.status === "available") {
			downloadImportedSourceInBrowser(outcome.filename, outcome.mediaType, outcome.bytes);
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

				{conversation !== null && onConversationChange !== undefined && (
					<ContinuationSettings
						conversation={conversation}
						onConversationChange={onConversationChange}
					/>
				)}

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
	downloadOutcome: { status: "idle" } | { status: "downloading" } | ChatSourceDownloadOutcome;
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
					<dd>{formatSize(details.receipt.byteLength)}</dd>
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

			{details.receipt.warnings.length > 0 && (
				<div className="import-warnings">
					<h3>Warnings</h3>
					<ul>
						{details.receipt.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</div>
			)}

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
						downloadOutcome.status === "downloading"
					}
					onClick={onDownload}
				>
					<Download aria-hidden="true" />
					{downloadOutcome.status === "downloading"
						? "Preparing download…"
						: "Download original file"}
				</button>
				{downloadOutcome.status === "cleaned-up" && (
					<p className="import-problem" role="alert">
						The original file is missing or no longer matches its recorded
						checksum. You can still read and edit this Chat, but you cannot
						download the original file.
					</p>
				)}
				{downloadOutcome.status === "network" && (
					<p className="import-problem" role="alert">
						The download could not be prepared. Check the connection and
						try again.
					</p>
				)}
			</div>

		</section>
	);
}

function ContinuationSettings({
	conversation,
	onConversationChange,
}: {
	conversation: ConversationSummary;
	onConversationChange: (conversation: ConversationSummary) => void;
}) {
	const [settings, setSettings] = useState<ConversationGenerationSettings | null>(null);
	const [instruction, setInstruction] = useState("");
	const [strategy, setStrategy] = useState<ConversationGenerationSettings["continuationStrategy"]>("instruction");
	const [prefillSuffix, setPrefillSuffix] = useState<ContinuationPrefillSuffix>("");
	const [status, setStatus] = useState<"loading" | "ready" | "saving" | "error">("loading");
	useEffect(() => {
		let cancelled = false;
		setStatus("loading");
		void loadConversationGenerationSettings(conversation.id)
			.then((loaded) => {
				if (cancelled) return;
				setSettings(loaded);
				setInstruction(loaded.continuationInstruction);
				setStrategy(loaded.continuationStrategy);
				setPrefillSuffix(loaded.continuationPrefillSuffix);
				setStatus("ready");
			})
			.catch(() => { if (!cancelled) setStatus("error"); });
		return () => { cancelled = true; };
	}, [conversation.id]);

	const saveInstruction = async () => {
		if (settings === null || instruction.trim() === "") return;
		setStatus("saving");
		const next = {
			...settings,
			continuationStrategy: strategy,
			continuationInstruction: instruction,
			continuationPrefillSuffix: prefillSuffix,
		};
		const outcome = await applyConversationCommand(conversation.id, conversation.revision, {
			type: "update-generation-settings",
			settings: next,
		});
		if (outcome.status === "applied") {
			setSettings(next);
			setStrategy(next.continuationStrategy);
			setPrefillSuffix(next.continuationPrefillSuffix);
			onConversationChange(outcome.conversation);
			setStatus("ready");
			return;
		}
		setStatus("error");
	};

	return (
		<section className="continuation-settings" aria-labelledby="continuation-settings-title">
			<h3 id="continuation-settings-title">Continuation</h3>
			{status === "loading" && <p className="panel-note">Loading Continuation settings…</p>}
			{status === "error" && <p className="import-problem" role="alert">Continuation settings could not be saved.</p>}
			{settings !== null && status !== "loading" && (
				<>
					<label htmlFor="continuation-strategy">Strategy</label>
					<select
						id="continuation-strategy"
						value={strategy}
						onChange={(event) => setStrategy(continuationStrategyValue(event.target.value))}
					>
						<option value="instruction">Instruction</option>
						<option value="assistant-prefill">Assistant prefill</option>
					</select>
					{strategy === "assistant-prefill" && (
						<>
							<label htmlFor="continuation-prefill-suffix">Prefill suffix</label>
							<select
								id="continuation-prefill-suffix"
								value={prefillSuffix}
								onChange={(event) => setPrefillSuffix(continuationPrefillSuffixValue(event.target.value))}
							>
								<option value="">None</option>
								<option value=" ">Space</option>
								<option value="\n">Newline</option>
								<option value="\n\n">Double newline</option>
							</select>
						</>
					)}
					<label htmlFor="continuation-instruction">Continuation instruction</label>
					<textarea
						id="continuation-instruction"
						value={instruction}
						onChange={(event) => setInstruction(event.target.value)}
						rows={3}
					/>
					<button className="secondary-button" type="button" disabled={status === "saving" || instruction.trim() === ""} onClick={() => void saveInstruction()}>
						{status === "saving" ? "Saving…" : "Save Continuation settings"}
					</button>
				</>
			)}
		</section>
	);
}
