import {
	ArrowLeft,
	Check,
	FileUp,
	Loader2,
	RefreshCw,
	ShieldAlert,
	TriangleAlert,
	Upload,
	X,
} from "lucide-react";
import { useEffect, useRef } from "react";
import {
	allSuggestionsConfirmed,
	cancelNeedsWarning,
	shouldBeginUpload,
	type ChatImportFlowAction,
	type ChatImportFlowState,
} from "./import-chat-flow";
import { chatImportTransport } from "./import-chat";

// The nested Import Chat flow inside the Chats primary panel. The flow is
// deliberately review-only: choosing one local export uploads its bytes
// once into managed staging, validation finishes before anything else, and
// the staged preview surfaces source identity, counts, warnings, duplicate
// evidence, exact author groups, and name-only Character suggestions. No
// native Chat, Participant, or Actor Profile is created by this step.
//
// Back and Cancel follow the nested-panel pattern: Back returns to file
// selection (discarding the staged handle), Cancel warns before discarding
// the open flow and then removes only that flow's uncommitted temporary
// staging data. The same panel inherits the primary panel's full-screen
// narrow-width treatment; there is no separate mobile workflow.

interface ImportChatPanelProps {
	flow: ChatImportFlowState;
	onDispatch: (action: ChatImportFlowAction) => void;
	// Back at the choosing step: close the nested flow to the Chats list.
	onBackToList: () => void;
	// Cancel confirmed (or no staged work): close the nested flow.
	onClose: () => void;
}

const sourceSize = (byteLength: number | null): string => {
	if (byteLength === null) return "";
	if (byteLength < 1024) return `${byteLength} B`;
	const kilobytes = byteLength / 1024;
	if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
	return `${(kilobytes / 1024).toFixed(1)} MB`;
};

export function ImportChatPanel({
	flow,
	onDispatch,
	onBackToList,
	onClose,
}: ImportChatPanelProps) {
	const cancelledRef = useRef(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		cancelledRef.current = false;
		return () => {
			cancelledRef.current = true;
		};
	}, []);

	// The discard orchestration is the only place temporary staging data is
	// removed: Back from the preview, confirmed Cancel, and nothing else.
	const discardStaged = (token: string | null) => {
		if (token === null) return;
		void chatImportTransport.discard(token);
	};

	const runStage = async (file: File) => {
		const outcome = await chatImportTransport.stage(file, file.name);
		if (cancelledRef.current) return;
		onDispatch(
			outcome.status === "staged"
				? {
						type: "stage-succeeded",
						stage: { token: outcome.token, preview: outcome.preview },
					}
				: {
						type: "stage-failed",
						reason:
							outcome.status === "invalid"
								? outcome.reason
								: "The file could not be uploaded. Check the connection and choose it again.",
					},
		);
	};

	const refreshPreview = async () => {
		if (flow.token === null || flow.sha256 === null) return;
		const outcome = await chatImportTransport.preview(flow.token, flow.sha256);
		if (cancelledRef.current) return;
		if (outcome.status === "available") {
			onDispatch({ type: "preview-succeeded", preview: outcome.preview });
			return;
		}
		onDispatch({
			type: "preview-failed",
			reason:
				outcome.status === "expired" || outcome.status === "unavailable"
					? "This staged import is no longer available. Go back and choose the file again."
					: "The preview could not be refreshed. Try again.",
		});
	};

	const handleFileChosen = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		// Clearing the input lets the user choose the same file again after
		// a validation failure; the flow still uploads only one file once.
		event.target.value = "";
		if (file === undefined || !shouldBeginUpload(flow)) return;
		onDispatch({ type: "file-chosen" });
		void runStage(file);
	};

	const handleBack = () => {
		if (flow.phase === "preview") {
			discardStaged(flow.token);
			onDispatch({ type: "back-to-choose" });
			return;
		}
		onBackToList();
	};

	const handleCancel = () => {
		if (cancelNeedsWarning(flow)) {
			onDispatch({ type: "cancel-requested" });
			return;
		}
		// Nothing is staged yet; closing removes no data.
		onClose();
	};

	const handleConfirmCancel = () => {
		onDispatch({ type: "confirm-cancel" });
		discardStaged(flow.token);
		onClose();
	};

	return (
		<div className="import-flow">
			<header className="import-flow-header">
				<button
					className="icon-button import-flow-back"
					type="button"
					onClick={handleBack}
					aria-label={
						flow.phase === "preview" ? "Back to file selection" : "Back to Chats"
					}
				>
					<ArrowLeft aria-hidden="true" />
				</button>
				<h2>Import Chat</h2>
				<button
					className="icon-button import-flow-cancel"
					type="button"
					onClick={handleCancel}
					aria-label="Cancel import"
				>
					<X aria-hidden="true" />
				</button>
			</header>

			<div className="panel-body import-flow-body">
				{flow.phase === "choose" && (
					<ChooseStep
						flow={flow}
						onPick={() => fileInputRef.current?.click()}
					/>
				)}
				{flow.phase === "staging" && <StagingStep />}
				{flow.phase === "preview" && (
					<PreviewStep
						flow={flow}
						onDispatch={onDispatch}
						onRefresh={refreshPreview}
						onBack={handleBack}
						onCancel={handleCancel}
					/>
				)}

				<input
					ref={fileInputRef}
					className="sr-only"
					type="file"
					accept=".jsonl,application/jsonl,.ndjson,application/x-ndjson,.json,application/json"
					onChange={handleFileChosen}
				/>

				{flow.cancelPending && (
					<section className="import-confirm-cancel" role="alertdialog" aria-label="Confirm cancel">
						<ShieldAlert aria-hidden="true" />
						<div>
							<strong>Discard this import?</strong>
							<p>
								The uploaded file and the staged preview would be removed.
								Nothing has been created yet.
							</p>
						</div>
						<div className="import-confirm-actions">
							<button
								className="secondary-button"
								type="button"
								onClick={() => onDispatch({ type: "cancel-abandoned" })}
							>
								Keep editing
							</button>
							<button
								className="danger-button"
								type="button"
								onClick={handleConfirmCancel}
							>
								Discard import
							</button>
						</div>
					</section>
				)}
			</div>
		</div>
	);
}

function ChooseStep({
	flow,
	onPick,
}: {
	flow: ChatImportFlowState;
	onPick: () => void;
}) {
	return (
		<div className="import-choose">
			<p className="panel-intro">
				Import one SillyTavern export. Its contents are validated before
				anything is created, and nothing is saved until you finish a later
				review step.
			</p>

			<button className="import-file-button" type="button" onClick={onPick}>
				<span className="import-file-icon">
					<Upload aria-hidden="true" />
				</span>
				<strong>Choose a SillyTavern export</strong>
				<small>One file, any extension. JSONL is preferred.</small>
			</button>

			{flow.problem !== null && (
				<p className="import-problem" role="alert">
					{flow.problem}
				</p>
			)}

			<p className="panel-note">
				The file is uploaded once into a temporary staged import. A server
				restart expires the staged flow and requires reselecting the file.
			</p>
		</div>
	);
}

function StagingStep() {
	return (
		<div className="import-staging" role="status" aria-live="polite">
			<Loader2 className="import-spinner" aria-hidden="true" />
			<strong>Uploading and validating the export</strong>
			<p>Malformed JSON, invalid UTF-8, and structural defects are reported here before any resolution begins.</p>
		</div>
	);
}

function PreviewStep({
	flow,
	onDispatch,
	onRefresh,
	onBack,
	onCancel,
}: {
	flow: ChatImportFlowState;
	onDispatch: (action: ChatImportFlowAction) => void;
	onRefresh: () => void;
	onBack: () => void;
	onCancel: () => void;
}) {
	const exactCount = flow.duplicates.exact.length;
	const relatedCount = flow.duplicates.related.length;

	return (
		<div className="import-preview">
			<div className="import-preview-actions">
				<button className="secondary-button" type="button" onClick={onRefresh}>
					<RefreshCw aria-hidden="true" /> Refresh preview
				</button>
			</div>

			{exactCount > 0 && (
				<p className="import-duplicate-banner" role="alert">
					<TriangleAlert aria-hidden="true" />
					<span>
						This exact source was already imported as{" "}
						{flow.duplicates.exact.map((match) => `Chat ${match.id}`).join(", ")}.
						An exact duplicate needs explicit confirmation before an
						independent copy is committed.
					</span>
				</p>
			)}
			{exactCount === 0 && relatedCount > 0 && (
				<p className="import-related-banner">
					<span>
						A related source with the same declared integrity was imported
						as {flow.duplicates.related.map((match) => `Chat ${match.id}`).join(", ")}.
						This is not a byte-identical copy.
					</span>
				</p>
			)}

			<label className="seat-field">
				<span>Chat title</span>
				<input
					value={flow.title}
					placeholder="Title this Chat"
					onChange={(event) =>
						onDispatch({ type: "title-changed", title: event.target.value })
					}
				/>
			</label>

			<section className="import-source">
				<h3>Source</h3>
				<dl className="detail-list import-meta-list">
					<div>
						<dt>Original filename</dt>
						<dd>{flow.filename}</dd>
					</div>
					<div>
						<dt>SHA-256</dt>
						<dd className="import-sha">{flow.sha256}</dd>
					</div>
					<div>
						<dt>Size</dt>
						<dd>{sourceSize(flow.byteLength)}</dd>
					</div>
					{flow.integrity !== null && (
						<div>
							<dt>Declared integrity</dt>
							<dd className="import-sha">{flow.integrity}</dd>
						</div>
					)}
					<div>
						<dt>Messages</dt>
						<dd>{flow.counts?.messages ?? 0}</dd>
					</div>
					<div>
						<dt>Variants</dt>
						<dd>{flow.counts?.variants ?? 0}</dd>
					</div>
				</dl>
			</section>

			{flow.warnings.length > 0 && (
				<section className="import-warnings">
					<h3>Warnings</h3>
					<ul>
						{flow.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</section>
			)}

			<section className="import-groups">
				<h3>Author groups</h3>
				<p className="panel-intro">
					One group per exact captured author string, in first-appearance
					order. Case and whitespace variants stay separate; blank captured
					names appear explicitly with an editable default.
				</p>
				{flow.groups.map((group) => (
					<article className="import-group" key={group.key}>
						<header className="import-group-header">
							<div>
								<strong>{group.isBlank ? "Blank captured name" : group.key}</strong>
								<small>
									{group.messageCount} Message{group.messageCount === 1 ? "" : "s"}
									{" · "}
									{group.variantCount} Variant{group.variantCount === 1 ? "" : "s"}
								</small>
							</div>
							{group.suggestion !== null && (
								<span className="import-suggest-tag" data-approved={group.confirmed}>
									{group.confirmed ? "Approved" : "Suggested"}
								</span>
							)}
						</header>
						<label className="seat-field">
							<span>Participant name</span>
							<input
								value={group.participantName}
								onChange={(event) =>
									onDispatch({
										type: "group-name-changed",
										key: group.key,
										name: event.target.value,
									})
								}
							/>
						</label>
						{group.suggestion !== null && (
							<div className="import-suggestion">
								<span>
									<FileUp aria-hidden="true" />
									{group.confirmed
										? `Character association approved: ${group.suggestion.name}`
										: `Suggested Character: ${group.suggestion.name} (${group.suggestion.match} name match)`}
								</span>
								{!group.confirmed && (
									<button
										className="primary-button"
										type="button"
										onClick={() =>
											onDispatch({
												type: "suggestion-confirmed",
												key: group.key,
											})
										}
									>
										<Check aria-hidden="true" /> Approve
									</button>
								)}
							</div>
						)}
					</article>
				))}
			</section>

			{flow.problem !== null && (
				<p className="import-problem" role="alert">
					{flow.problem}
				</p>
			)}

			<div className="import-preview-footer">
				<button className="secondary-button" type="button" onClick={onBack}>
					<ArrowLeft aria-hidden="true" /> Choose another file
				</button>
				<button className="secondary-button" type="button" onClick={onCancel}>
					Cancel
				</button>
				<p className="panel-note">
					{allSuggestionsConfirmed(flow)
						? "This staged preview is complete and ready for the next review step."
						: "Approve the suggested Character associations before this preview can pass final review."}
				</p>
			</div>
		</div>
	);
}