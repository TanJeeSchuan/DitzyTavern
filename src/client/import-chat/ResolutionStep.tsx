import { ArrowLeft, RefreshCw, TriangleAlert, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
	resolutionReady,
	type ChatImportFlowAction,
	type ChatImportFlowState,
} from "../import-chat-flow";
import {
	ImportRelatedNotice,
	ImportTitleField,
	ImportWarningsList,
} from "./ImportNotices";
import { ResolvedGroupCard } from "./ResolvedGroupCard";
import { SourceCard } from "./SourceCard";

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
	// @approved
	//  Presentation-only merge selection; the reducer only sees the confirmed
	// merge action with its explicit target and sources.
	const [mergeSelection, setMergeSelection] = useState<readonly string[]>([]);
	const ready = resolutionReady(flow);

	// @approved
	//  Defensive cleanup: selections referencing removed segments never leak.
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
			{exactCount === 0 && (
				<ImportRelatedNotice related={flow.duplicates.related} />
			)}

			<ImportTitleField
				title={flow.title}
				placeholder="Title this Chat"
				onTitleChange={(title) => onDispatch({ type: "title-changed", title })}
			/>

			<SourceCard handle={flow.handle} counts={flow.counts} showDeclaredIntegrity />

			<ImportWarningsList warnings={flow.warnings} />

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

