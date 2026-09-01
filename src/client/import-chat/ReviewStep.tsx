import { ArrowLeft, TriangleAlert } from "lucide-react";
import {
	canCommit,
	deriveDuplicateNameWarnings,
	type ChatImportFlowAction,
	type ChatImportFlowState,
	variantCountForGroup,
} from "../import-chat-flow";
import { outcomeLabel, sourceSize } from "./presentation";

export function ReviewStep({
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
								{group.messages.length} Message
								{group.messages.length === 1 ? "" : "s"} · {variantCountForGroup(group)}{" "}
								Variant{variantCountForGroup(group) === 1 ? "" : "s"}
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
						This exact file was already imported as{" "}
						{flow.duplicates.exact.map((match) => `Chat ${match.id}`).join(", ")}.
						Importing again creates a separate Chat.
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
						A related import was found in{" "}
						{flow.duplicates.related.map((match) => `Chat ${match.id}`).join(", ")}.
						Both files report the same integrity value, but their bytes differ.
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
						? "Everything is confirmed. The file being imported is the one you previewed."
						: "Resolve every Participant and confirm any unnamed author or duplicate import before importing."}
				</p>
			</div>
		</div>
	);
}

