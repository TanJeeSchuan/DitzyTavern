import {
	ArrowLeft,
	Check,
	ChevronDown,
	ChevronUp,
	FileUp,
	Loader2,
	RefreshCw,
	ShieldAlert,
	TriangleAlert,
	Undo2,
	Upload,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	UNKNOWN_IMPORTED_AUTHOR_NAME,
	buildResolvedParticipants,
	canCommit,
	cancelNeedsWarning,
	deriveDuplicateNameWarnings,
	resolutionReady,
	shouldBeginUpload,
	type ChatImportFlowAction,
	type ChatImportFlowState,
	type ImportGroupDraft,
} from "./import-chat-flow";
import {
	chatImportTransport,
	discardStagedImport,
	type ChatImportReceipt,
} from "./import-chat";

// The nested Import Chat flow inside the Chats primary panel. The flow is
// review-driven: choosing one local export uploads its bytes once into
// managed staging, validation finishes before anything else, the staged
// preview resolves exact captured author groups into native Participants,
// the final review presents the complete operation, and the commit creates
// one ordinary native Chat through public domain seams. No imported-only
// badge, category, or capability flag is ever added.
//
// Back and Cancel follow the nested-panel pattern: Back returns to the
// previous step without discarding resolution work (only Back to file
// selection drops the staged handle), Cancel warns before discarding the
// open flow and then removes only that flow's uncommitted temporary staging
// data. The same panel inherits the primary panel's full-screen narrow-width
// treatment; there is no separate mobile workflow.

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

const sourceSize = (byteLength: number | null): string => {
	if (byteLength === null) return "";
	if (byteLength < 1024) return `${byteLength} B`;
	const kilobytes = byteLength / 1024;
	if (kilobytes < 1024) return `${kilobytes.toFixed(1)} KB`;
	return `${(kilobytes / 1024).toFixed(1)} MB`;
};

const outcomeLabel = (outcome: ImportGroupDraft["outcome"]): string =>
	outcome.type === "fork"
		? "Existing Character"
		: outcome.type === "new-character"
			? "New Character"
			: "Chat-only";

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
				anything is created, and nothing is saved until you finish the
				final review step.
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
			<p>
				Malformed JSON, invalid UTF-8, and structural defects are reported
				here before any resolution begins.
			</p>
		</div>
	);
}

function CommittingStep() {
	return (
		<div className="import-staging" role="status" aria-live="polite">
			<Loader2 className="import-spinner" aria-hidden="true" />
			<strong>Committing the import</strong>
			<p>
				The Chat, requested new Characters, Participants, Messages, and the
				exact preserved source commit together as one operation.
			</p>
		</div>
	);
}

// ---- Participant resolution ----

function ResolutionStep({
	flow,
	characters,
	onDispatch,
	onRefresh,
	onBack,
	onCancel,
	onContinue,
}: {
	flow: ChatImportFlowState;
	characters: { id: number; name: string }[];
	onDispatch: (action: ChatImportFlowAction) => void;
	onRefresh: () => void;
	onBack: () => void;
	onCancel: () => void;
	onContinue: () => void;
}) {
	const exactCount = flow.duplicates.exact.length;
	const relatedCount = flow.duplicates.related.length;
	// Presentation-only merge selection; the reducer only sees the confirmed
	// merge action with its explicit target and sources.
	const [mergeSelection, setMergeSelection] = useState<readonly string[]>([]);
	const ready = resolutionReady(flow);

	// Defensive cleanup: selections referencing removed segments never leak.
	const mergeTargets = useMemo(
		() =>
			flow.groups.filter((group) => mergeSelection.includes(group.id)),
		[flow.groups, mergeSelection],
	);

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
						An exact duplicate needs explicit confirmation at the final
						review before an independent copy is committed.
					</span>
				</p>
			)}
			{exactCount === 0 && relatedCount > 0 && (
				<p className="import-related-banner">
					<span>
						A related source with the same declared integrity was imported
						as{" "}
						{flow.duplicates.related.map((match) => `Chat ${match.id}`).join(", ")}.
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
						<dd>{flow.handle?.originalFilename}</dd>
					</div>
					<div>
						<dt>SHA-256</dt>
						<dd className="import-sha">{flow.handle?.sha256}</dd>
					</div>
					<div>
						<dt>Size</dt>
						<dd>{sourceSize(flow.handle?.byteLength ?? null)}</dd>
					</div>
					{flow.handle?.integrity !== null && flow.handle?.integrity !== undefined && (
						<div>
							<dt>Declared integrity</dt>
							<dd className="import-sha">{flow.handle?.integrity}</dd>
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
				<h3>Resolve Participants</h3>
				<p className="panel-intro">
					One participant begins per exact captured author string. Merge
					spelling variants or aliases into one Participant, split selected
					Messages into another Participant, and undo either change before
					commit. Every Message stays assigned; nothing is skipped.
				</p>
				{flow.groups.map((group) => (
					<ResolvedGroupCard
						key={group.id}
						group={group}
						groups={flow.groups}
						characters={characters}
						mergeSelected={mergeSelection.includes(group.id)}
						onMergeToggle={(selected) =>
							setMergeSelection((current) =>
								selected
									? [...current, group.id]
									: current.filter((id) => id !== group.id),
							)
						}
						onDispatch={onDispatch}
						mergeTargets={mergeTargets}
						onMerged={() => setMergeSelection([])}
					/>
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
				<button
					className="secondary-button"
					type="button"
					disabled={flow.history.length === 0}
					onClick={() => onDispatch({ type: "undo-resolution" })}
				>
					<Undo2 aria-hidden="true" /> Undo
				</button>
				<button
					className="primary-button"
					type="button"
					disabled={!ready}
					onClick={onContinue}
				>
					Continue to review
				</button>
				<p className="panel-note">
					{ready
						? "Every Participant is resolved; continue to the final review."
						: "Resolve every Participant: name each one, approve or change every Character choice, confirm blank captured names, and assign at least one Message per Participant."}
				</p>
			</div>
		</div>
	);
}

function ResolvedGroupCard({
	group,
	groups,
	characters,
	mergeSelected,
	onMergeToggle,
	onDispatch,
	mergeTargets,
	onMerged,
}: {
	group: ImportGroupDraft;
	groups: readonly ImportGroupDraft[];
	characters: { id: number; name: string }[];
	mergeSelected: boolean;
	onMergeToggle: (selected: boolean) => void;
	onDispatch: (action: ChatImportFlowAction) => void;
	mergeTargets: readonly ImportGroupDraft[];
	onMerged: () => void;
}) {
	const [messagesOpen, setMessagesOpen] = useState(false);
	const [splitTarget, setSplitTarget] = useState<string>("new");
	const blankAffected = group.messageIsBlankSource.some(Boolean);
	const selected = group.selectedPositions;
	const selectedVariantCount = useMemo(() => {
		const byPosition = new Map(
			group.messagePositions.map((position, index) => [
				position,
				group.messageVariantCounts[index] ?? 0,
			]),
		);
		return selected.reduce(
			(total, position) => total + (byPosition.get(position) ?? 0),
			0,
		);
	}, [group.messagePositions, group.messageVariantCounts, selected]);

	const splitAffordance = selected.length > 0;

	return (
		<article className="import-group">
			<header className="import-group-header">
				<div>
					<strong>
						{group.isBlank ? "Blank captured name" : group.key}
						{group.isBlank && (
							<span className="import-blank-tag">blank source</span>
						)}
					</strong>
					<small>
						{group.messageCount} Message
						{group.messageCount === 1 ? "" : "s"} · {group.variantCount} Variant
						{group.variantCount === 1 ? "" : "s"}
					</small>
				</div>
				<label className="import-merge-toggle" title="Select for merging">
					<input
						type="checkbox"
						checked={mergeSelected}
						onChange={(event) => onMergeToggle(event.target.checked)}
					/>
					<span>Merge</span>
				</label>
			</header>

			<label className="seat-field">
				<span>Participant name</span>
				<input
					value={group.participantName}
					placeholder={
						group.isBlank
							? UNKNOWN_IMPORTED_AUTHOR_NAME
							: "Name this Participant"
					}
					onChange={(event) =>
						onDispatch({
							type: "group-name-changed",
							id: group.id,
							name: event.target.value,
						})
					}
				/>
			</label>

			<div className="import-outcome" role="group" aria-label="Resolution outcome">
				<OutcomeChoice
					label="Fork existing Character"
					hint="Copies the Profile into this Participant"
					name={`import-outcome-${group.id}`}
					checked={group.outcome.type === "fork"}
					disabled={group.suggestion === null && characters.length === 0}
					onSelect={() => {
						// The radio alone never approves: the pre-filled suggestion
						// or the first library Character becomes the fork target and
						// stays unconfirmed until the explicit approval action.
						const characterId =
							group.suggestion?.characterId ?? characters[0]?.id;
						if (characterId === undefined) return;
						onDispatch({
							type: "outcome-changed",
							id: group.id,
							outcome: { type: "fork", characterId },
						});
					}}
				/>
				{group.outcome.type === "fork" && (
					<ForkPicker
						group={group}
						characters={characters}
						onDispatch={onDispatch}
					/>
				)}
				<OutcomeChoice
					label="Create a new Character"
					hint="Adds this Participant to the Character Library"
					name={`import-outcome-${group.id}`}
					checked={group.outcome.type === "new-character"}
					onSelect={() =>
						onDispatch({
							type: "outcome-changed",
							id: group.id,
							outcome: { type: "new-character" },
						})
					}
				/>
				<OutcomeChoice
					label="Keep Chat-only"
					hint="A complete Participant without a Library Profile"
					name={`import-outcome-${group.id}`}
					checked={group.outcome.type === "chat-only"}
					onSelect={() =>
						onDispatch({
							type: "outcome-changed",
							id: group.id,
							outcome: { type: "chat-only" },
						})
					}
				/>
			</div>

			{blankAffected && (
				<div className="import-blank-confirm">
					<TriangleAlert aria-hidden="true" />
					<span>
						This Participant includes Messages from a blank captured name.
						Confirm the name above or edit it before importing.
					</span>
					{!group.blankNameConfirmed && (
						<button
							className="secondary-button"
							type="button"
							onClick={() =>
								onDispatch({
									type: "blank-name-confirmed",
									id: group.id,
								})
							}
						>
							<Check aria-hidden="true" /> Confirm name
						</button>
					)}
				</div>
			)}

			<button
				className="import-messages-toggle"
				type="button"
				onClick={() => setMessagesOpen((current) => !current)}
				aria-expanded={messagesOpen}
			>
				<span>
					Inspect Messages ({group.messageCount})
				</span>
				{messagesOpen ? (
					<ChevronUp aria-hidden="true" />
				) : (
					<ChevronDown aria-hidden="true" />
				)}
			</button>

			{messagesOpen && (
				<div className="import-message-list">
					{group.messagePositions.map((position, index) => (
						<label className="import-message-entry" key={position}>
							<input
								type="checkbox"
								checked={group.selectedPositions.includes(position)}
								onChange={(event) =>
									onDispatch({
										type: "message-selected",
										id: group.id,
										position,
										selected: event.target.checked,
									})
								}
							/>
							<span>
								Message {position}
								{group.messageIsBlankSource[index] === true && (
									<small className="import-blank-source">blank name</small>
								)}
							</span>
							<small>
								{group.messageVariantCounts[index] ?? 0} Variant
								{(group.messageVariantCounts[index] ?? 0) === 1 ? "" : "s"}
							</small>
						</label>
					))}
				</div>
			)}

			{splitAffordance && (
				<div className="import-split-bar">
					<span>
						Move {selected.length} selected Message
						{selected.length === 1 ? "" : "s"} ({selectedVariantCount} Variant
						{selectedVariantCount === 1 ? "" : "s"}):
					</span>
					<select
						value={splitTarget}
						onChange={(event) => setSplitTarget(event.target.value)}
						aria-label="Split target"
					>
						<option value="new">into a new Participant</option>
						{groups
							.filter((candidate) => candidate.id !== group.id)
							.map((candidate) => (
								<option key={candidate.id} value={candidate.id}>
									into {candidate.participantName.trim() || candidate.key}
								</option>
							))}
					</select>
					<button
						className="secondary-button"
						type="button"
						onClick={() => {
							if (splitTarget === "new") {
								onDispatch({
									type: "split-new",
									fromId: group.id,
									positions: [...group.selectedPositions],
									newId: crypto.randomUUID(),
								});
								return;
							}
							onDispatch({
								type: "split-out",
								fromId: group.id,
								toId: splitTarget,
								positions: [...group.selectedPositions],
							});
						}}
					>
						Move
					</button>
				</div>
			)}

			{mergeTargets.length > 1 &&
				mergeTargets.some((candidate) => candidate.id === group.id) && (
					<div className="import-merge-bar">
					<span>
						Merge {mergeTargets.length} selected groups into one Participant:
					</span>
					<select
						value={group.id}
						onChange={(event) => {
							const targetId = event.target.value;
							onDispatch({
								type: "merge-into",
								targetId,
								sourceIds: mergeTargets
									.map((candidate) => candidate.id)
									.filter((id) => id !== targetId),
							});
							onMerged();
						}}
						aria-label="Merge target"
					>
						{mergeTargets.map((candidate) => (
							<option key={candidate.id} value={candidate.id}>
								{candidate.participantName.trim() || candidate.key}
							</option>
						))}
					</select>
				</div>
			)}

			{group.outcome.type === "fork" && !group.suggestedApproved && (
				<div className="import-suggestion">
					<span>
						<FileUp aria-hidden="true" />
						{group.suggestion !== null
							? `Suggested Character: ${group.suggestion.name} (${group.suggestion.match} name match)`
							: "Choose a Character; the selection is confirmed when you confirm it."}
					</span>
					<button
						className="primary-button"
						type="button"
						onClick={() =>
							onDispatch({ type: "suggestion-approved", id: group.id })
						}
					>
						<Check aria-hidden="true" />
						{group.suggestion !== null &&
						group.outcome.type === "fork" &&
						group.outcome.characterId === group.suggestion.characterId
							? "Approve"
							: "Confirm Character"}
					</button>
				</div>
			)}
		</article>
	);
}

function OutcomeChoice({
	label,
	hint,
	checked,
	disabled = false,
	name,
	onSelect,
}: {
	label: string;
	hint: string;
	checked: boolean;
	disabled?: boolean;
	// Radio inputs group by name across the whole document, so every
	// Participant's outcome group needs its own name to keep resolutions
	// independent.
	name?: string;
	onSelect: () => void;
}) {
	return (
		<label className="import-outcome-choice" data-checked={checked}>
			<input
				type="radio"
				name={name}
				checked={checked}
				disabled={disabled}
				onChange={onSelect}
			/>
			<span>
				<strong>{label}</strong>
				<small>{hint}</small>
			</span>
		</label>
	);
}

function ForkPicker({
	group,
	characters,
	onDispatch,
}: {
	group: ImportGroupDraft;
	characters: { id: number; name: string }[];
	onDispatch: (action: ChatImportFlowAction) => void;
}) {
	const suggestionId =
		group.suggestion === null ? null : group.suggestion.characterId;
	const currentId =
		group.outcome.type === "fork" ? group.outcome.characterId : suggestionId;
	const options = useMemo(() => {
		const list = [...characters];
		const known = new Set(list.map((character) => character.id));
		if (suggestionId !== null && !known.has(suggestionId)) {
			list.unshift({
				id: suggestionId,
				name: group.suggestion?.name ?? "Suggested Character",
			});
		}
		return list;
	}, [characters, suggestionId, group.suggestion]);

	return (
		<label className="import-fork-picker">
			<span>Character</span>
			<select
				value={currentId ?? ""}
				onChange={(event) => {
					const characterId = Number(event.target.value);
					onDispatch({
						type: "outcome-changed",
						id: group.id,
						outcome: { type: "fork", characterId },
					});
					// Picking a Character explicitly is the confirmation.
					onDispatch({ type: "suggestion-approved", id: group.id });
				}}
			>
				{options.length === 0 && <option value="">No Characters yet</option>}
				{options.map((character) => (
					<option key={character.id} value={character.id}>
						{character.name}
						{character.id === suggestionId ? " — Suggested" : ""}
					</option>
				))}
			</select>
		</label>
	);
}

// ---- Final review ----

function ReviewStep({
	flow,
	characters,
	onDispatch,
	onBack,
	onCommit,
}: {
	flow: ChatImportFlowState;
	characters: { id: number; name: string }[];
	onDispatch: (action: ChatImportFlowAction) => void;
	onBack: () => void;
	onCommit: () => void;
}) {
	const exactCount = flow.duplicates.exact.length;
	const duplicateNameWarnings = deriveDuplicateNameWarnings(flow, characters);
	const allWarnings = [...flow.warnings, ...duplicateNameWarnings];
	const commitReady = canCommit(flow);

	return (
		<div className="import-review">
			<label className="seat-field">
				<span>Chat title</span>
				<input
					value={flow.title}
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
						<dd>{flow.handle?.originalFilename}</dd>
					</div>
					<div>
						<dt>SHA-256</dt>
						<dd className="import-sha">{flow.handle?.sha256}</dd>
					</div>
					<div>
						<dt>Size</dt>
						<dd>{sourceSize(flow.handle?.byteLength ?? null)}</dd>
					</div>
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

			<section className="import-review-participants">
				<h3>Participants</h3>
				<ul>
					{flow.groups.map((group) => (
						<li key={group.id}>
							<span className="import-review-name">
								{group.participantName.trim() || "Unnamed Participant"}
							</span>
							<span className="import-review-outcome">
								{outcomeLabel(group.outcome)}
							</span>
							<small>
								{group.messageCount} Message
								{group.messageCount === 1 ? "" : "s"} · {group.variantCount}{" "}
								Variant{group.variantCount === 1 ? "" : "s"}
							</small>
						</li>
					))}
				</ul>
			</section>

			{allWarnings.length > 0 && (
				<section className="import-warnings">
					<h3>Warnings</h3>
					<ul>
						{allWarnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</section>
			)}

			{exactCount > 0 && (
				<section className="import-duplicate-confirm" role="alert">
					<TriangleAlert aria-hidden="true" />
					<span>
						This exact source was already imported as{" "}
						{flow.duplicates.exact.map((match) => `Chat ${match.id}`).join(", ")}.
						Importing again creates an independent native copy.
					</span>
					<label>
						<input
							type="checkbox"
							checked={flow.duplicateConfirmed}
							onChange={(event) =>
								onDispatch({
									type: "duplicate-confirmed",
									confirmed: event.target.checked,
								})
							}
						/>
						<span>Import another copy</span>
					</label>
				</section>
			)}
			{exactCount === 0 && flow.duplicates.related.length > 0 && (
				<p className="import-related-banner">
					<span>
						A related source with the same declared integrity was imported
						as{" "}
						{flow.duplicates.related.map((match) => `Chat ${match.id}`).join(", ")}.
						This is not a byte-identical copy.
					</span>
				</p>
			)}

			{flow.problem !== null && (
				<p className="import-problem" role="alert">
					{flow.problem}
				</p>
			)}

			<div className="import-review-footer">
				<button className="secondary-button" type="button" onClick={onBack}>
					<ArrowLeft aria-hidden="true" /> Back to resolution
				</button>
				<button
					className="primary-button"
					type="button"
					disabled={!commitReady}
					onClick={onCommit}
				>
					Import this Chat
				</button>
				<p className="panel-note">
					{commitReady
						? "Everything is confirmed. The exact bytes previewed here are the bytes that will be imported."
						: "Finish the resolution step and confirm every blank name and exact-duplicate copy before importing."}
				</p>
			</div>
		</div>
	);
}

// ---- Success receipt ----

function SuccessStep({
	receipt,
	onOpen,
	onClose,
}: {
	receipt: ChatImportReceipt | null;
	onOpen: () => void;
	onClose: () => void;
}) {
	if (receipt === null) {
		return (
			<div className="import-success">
				<p className="import-problem" role="alert">
					The import finished but its receipt is unavailable. The Chat is
					listed in the Chats panel.
				</p>
				<button className="primary-button" type="button" onClick={onClose}>
					Close
				</button>
			</div>
		);
	}
	return (
		<div className="import-success">
			<div className="import-success-mark" aria-hidden="true">
				<Check />
			</div>
			<h3>Chat imported</h3>
			<p className="panel-intro">
				<strong>{receipt.title}</strong> was created as an ordinary Chat with{" "}
				{receipt.counts.messages} Message{receipt.counts.messages === 1 ? "" : "s"}{" "}
				and {receipt.counts.variants} Variant
				{receipt.counts.variants === 1 ? "" : "s"} from{" "}
				{receipt.originalFilename}.
			</p>

			<dl className="detail-list import-meta-list">
				<div>
					<dt>Chat</dt>
					<dd>{receipt.conversationId}</dd>
				</div>
				<div>
					<dt>SHA-256</dt>
					<dd className="import-sha">{receipt.sha256}</dd>
				</div>
				<div>
					<dt>Size</dt>
					<dd>{sourceSize(receipt.byteLength)}</dd>
				</div>
			</dl>

			<section className="import-review-participants">
				<h3>Participants</h3>
				<ul>
					{receipt.participants.map((participant, index) => (
						<li key={`${participant.name}-${index}`}>
							<span className="import-review-name">{participant.name}</span>
							<span className="import-review-outcome">
								{participant.outcome === "fork"
									? "Existing Character"
									: participant.outcome === "new-character"
										? "New Character"
										: "Chat-only"}
							</span>
							<small>
								{participant.sourceCharacterId === null
									? "No Profile"
									: `Profile ${participant.sourceCharacterId}`}
							</small>
						</li>
					))}
				</ul>
			</section>

			{receipt.warnings.length > 0 && (
				<section className="import-warnings">
					<h3>Warnings</h3>
					<ul>
						{receipt.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				</section>
			)}

			<div className="import-success-actions">
				<button className="primary-button" type="button" onClick={onOpen}>
					Open Chat
				</button>
				<button className="secondary-button" type="button" onClick={onClose}>
					Close
				</button>
			</div>
		</div>
	);
}