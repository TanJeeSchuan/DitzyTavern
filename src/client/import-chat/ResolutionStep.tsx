import { ArrowLeft, RefreshCw, TriangleAlert, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
	resolutionReady,
	type ChatImportFlowAction,
	type ChatImportFlowState,
} from "../import-chat-flow";
import { ResolvedGroupCard } from "./ResolvedGroupCard";
import { sourceSize } from "./presentation";

export function ResolutionStep({
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
	// ==[HUMAN APPROVED]== Presentation-only merge selection; the reducer only sees the confirmed
	// merge action with its explicit target and sources.
	const [mergeSelection, setMergeSelection] = useState<readonly string[]>([]);
	const ready = resolutionReady(flow);

	// ==[HUMAN APPROVED]== Defensive cleanup: selections referencing removed segments never leak.
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
						This exact file was already imported as{" "}
						{flow.duplicates.exact.map((match) => `Chat ${match.id}`).join(", ")}.
						Confirm at the final step if you want to import another copy.
					</span>
				</p>
			)}
			{exactCount === 0 && relatedCount > 0 && (
				<p className="import-related-banner">
					<span>
						A related import was found in{" "}
						{flow.duplicates.related.map((match) => `Chat ${match.id}`).join(", ")}.
						Both files report the same integrity value, but their bytes differ.
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
					We start with one Participant for each distinct author name in the
					file. Merge spelling variants or aliases, split selected Messages
					into another Participant, then confirm each choice. Every Message
					remains assigned.
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
						? "Every Participant is ready. Continue to review."
						: "Give each Participant a name, confirm each Character choice, name any unnamed author, and assign at least one Message to each."}
				</p>
			</div>
		</div>
	);
}

