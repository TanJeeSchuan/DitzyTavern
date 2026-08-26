import { ArrowLeft, ShieldAlert, X } from "lucide-react";
import { useEffect, useRef } from "react";
import {
	buildResolvedParticipants,
	canCommit,
	cancelNeedsWarning,
	shouldBeginUpload,
	type ChatImportFlowAction,
	type ChatImportFlowState,
} from "./import-chat-flow";
import {
	chatImportTransport,
	discardStagedImport,
} from "./import-chat";
import {
	ChooseStep,
	CommittingStep,
	StagingStep,
} from "./import-chat/ChooseStep";
import { ResolutionStep } from "./import-chat/ResolutionStep";
import { ReviewStep } from "./import-chat/ReviewStep";
import { SuccessStep } from "./import-chat/SuccessStep";

// Upload one file into temporary staging, validate it, then let the user
// resolve Participants before committing an ordinary Chat. Do not add an
// imported-only badge, category, or capability state.
//
// Back preserves resolution work except when returning to file selection.
// Cancel discards only this flow's uncommitted staging data.

interface ImportChatPanelProps {
	flow: ChatImportFlowState;
	onDispatch: (action: ChatImportFlowAction) => void;
	// Library Characters available to fork from during resolution.
	characters: { id: number; name: string }[];
	// The committed Chat is opened: the workspace reloads and selects it.
	onImportLaunched: (conversationId: number) => void;
	// Back at the choosing step: close the nested flow to the Chats list.
	onBackToList: () => void;
	// Cancel confirmed (or no staged work): close the nested flow.
	onClose: () => void;
}

export function ImportChatPanel({
	flow,
	onDispatch,
	characters,
	onImportLaunched,
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
	const handleBack = () => {
		if (flow.phase === "review") {
			onDispatch({ type: "back-to-preview" });
			return;
		}
		if (flow.phase === "preview") {
			discardStagedImport(flow.handle?.token ?? null);
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
		discardStagedImport(flow.handle?.token ?? null);
		onClose();
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
		const handle = flow.handle;
		if (handle === null) return;
		const outcome = await chatImportTransport.preview(handle.token, handle.sha256);
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

	const runCommit = async () => {
		const handle = flow.handle;
		if (handle === null || !canCommit(flow)) return;
		onDispatch({ type: "commit-started" });
		const outcome = await chatImportTransport.commit(handle.token, handle.sha256, {
			title: flow.title,
			duplicateConfirmed: flow.duplicateConfirmed,
			participants: buildResolvedParticipants(flow),
		});
		if (cancelledRef.current) return;
		if (outcome.status === "committed") {
			onDispatch({ type: "commit-succeeded", receipt: outcome.receipt });
			return;
		}
		onDispatch({
			type: "commit-failed",
			reason:
				outcome.status === "invalid"
					? outcome.reason
					: outcome.status === "expired" || outcome.status === "unavailable"
						? "This staged import is no longer available. Go back and choose the file again."
						: "The import could not be committed. Check the connection and try again; the staged preview and every choice stay available.",
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

	return (
		<div className="import-flow">
			<header className="import-flow-header">
				<button
					className="icon-button import-flow-back"
					type="button"
					onClick={handleBack}
					aria-label={
						flow.phase === "review"
							? "Back to participant resolution"
							: flow.phase === "preview"
								? "Back to file selection"
								: "Back to Chats"
					}
				>
					<ArrowLeft aria-hidden="true" />
				</button>
				<h2>
					{flow.phase === "review"
						? "Review import"
						: flow.phase === "committing"
							? "Importing"
							: flow.phase === "success"
								? "Import complete"
								: "Import Chat"}
				</h2>
				<button
					className="icon-button import-flow-cancel"
					type="button"
					onClick={handleCancel}
					aria-label={
						flow.phase === "success" ? "Close import receipt" : "Cancel import"
					}
					disabled={flow.phase === "committing"}
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
					<ResolutionStep
						flow={flow}
						characters={characters}
						onDispatch={onDispatch}
						onRefresh={refreshPreview}
						onBack={handleBack}
						onCancel={handleCancel}
						onContinue={() => onDispatch({ type: "review-ready" })}
					/>
				)}
				{flow.phase === "review" && (
					<ReviewStep
						flow={flow}
						characters={characters}
						onDispatch={onDispatch}
						onBack={() => onDispatch({ type: "back-to-preview" })}
						onCommit={() => void runCommit()}
					/>
				)}
				{flow.phase === "committing" && <CommittingStep />}
				{flow.phase === "success" && (
					<SuccessStep
						receipt={flow.receipt}
						onOpen={() => {
							const receipt = flow.receipt;
							if (receipt === null) return;
							onDispatch({ type: "success-dismissed" });
							onImportLaunched(receipt.conversationId);
						}}
						onClose={onClose}
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
					<section
						className="import-confirm-cancel"
						role="alertdialog"
						aria-label="Confirm cancel"
					>
						<ShieldAlert aria-hidden="true" />
						<div>
							<strong>Discard this import?</strong>
							<p>
								The uploaded file, the staged preview, and every resolution
								choice would be removed. Nothing has been created yet.
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
