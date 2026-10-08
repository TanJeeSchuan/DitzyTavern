import {
	Check,
	ChevronDown,
	ChevronUp,
	FileUp,
	TriangleAlert,
} from "lucide-react";
import { useMemo, useState } from "react";
import { AppSelect } from "@/components/ui/select";
import type {
	ChatImportFlowAction,
	ImportGroupDraft,
} from "../import-chat-flow";
import { variantCountForGroup } from "../import-chat-flow";
import { UNKNOWN_IMPORTED_AUTHOR_NAME } from "../../shared/imported-author";

export function ResolvedGroupCard({
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
	const blankAffected = group.messages.some((message) => message.isBlankSource);
	const selected = group.selectedPositions;
	const selectedVariantCount = useMemo(() => {
		const byPosition = new Map(
			group.messages.map((message) => [message.position, message.variantCount]),
		);
		return selected.reduce(
			(total, position) => total + (byPosition.get(position) ?? 0),
			0,
		);
	}, [group.messages, selected]);

	const splitAffordance = selected.length > 0;

	return (
		<article className="import-group">
			<header className="import-group-header">
				<div>
					<strong>
						{group.isBlank ? "Unnamed author" : group.key}
						{group.isBlank && (
							<span className="import-blank-tag">name missing</span>
						)}
					</strong>
					<small>
						{group.messages.length} Message
						{group.messages.length === 1 ? "" : "s"} · {variantCountForGroup(group)} Variant
						{variantCountForGroup(group) === 1 ? "" : "s"}
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
					hint="Copies this Character into the Participant"
					name={`import-outcome-${group.id}`}
					checked={group.outcome.type === "fork"}
					disabled={group.suggestion === null && characters.length === 0}
					onSelect={() => {
						// @approved
						//  The radio alone never approves: the pre-filled suggestion
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
					hint="Creates a Character from this Participant"
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
					hint="Keeps this Participant only in the Chat"
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
						This Participant includes Messages with no author name. Confirm or
						edit the name before importing.
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
					Inspect Messages ({group.messages.length})
				</span>
				{messagesOpen ? (
					<ChevronUp aria-hidden="true" />
				) : (
					<ChevronDown aria-hidden="true" />
				)}
			</button>

			{messagesOpen && (
				<div className="import-message-list">
					{group.messages.map((message) => (
						<label className="import-message-entry" key={message.position}>
							<input
								type="checkbox"
								checked={group.selectedPositions.includes(message.position)}
								onChange={(event) =>
									onDispatch({
										type: "message-selected",
										id: group.id,
										position: message.position,
										selected: event.target.checked,
									})
								}
							/>
							<span>
								Message {message.position}
								{message.isBlankSource && (
									<small className="import-blank-source">blank name</small>
								)}
							</span>
							<small>
								{message.variantCount} Variant
								{message.variantCount === 1 ? "" : "s"}
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
					<AppSelect
						value={splitTarget}
						onValueChange={setSplitTarget}
						aria-label="Split target"
						options={[{ value: "new", label: "into a new Participant" }, ...groups
							.filter((candidate) => candidate.id !== group.id)
							.map((candidate) => ({ value: candidate.id, label: `into ${candidate.participantName.trim() || candidate.key}` }))]}
					/>
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
					<AppSelect
						value={group.id}
						onValueChange={(targetId) => {
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
						options={mergeTargets.map((candidate) => ({ value: candidate.id, label: candidate.participantName.trim() || candidate.key }))}
					/>
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
	// @approved
	//  Radio inputs group by name across the whole document, so every
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
			<AppSelect
				value={currentId ?? ""}
				onValueChange={(value) => {
					const characterId = Number(value);
					onDispatch({
						type: "outcome-changed",
						id: group.id,
						outcome: { type: "fork", characterId },
					});
					// @approved
					// Picking a Character explicitly is the confirmation.
					onDispatch({ type: "suggestion-approved", id: group.id });
				}}
				emptyLabel={options.length === 0 ? "No Characters yet" : "Choose a Character"}
				disabled={options.length === 0}
				options={options.map((character) => ({ value: character.id, label: `${character.name}${character.id === suggestionId ? " — Suggested" : ""}` }))}
			/>
		</label>
	);
}
