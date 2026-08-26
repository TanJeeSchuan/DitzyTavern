import { useEffect, useState } from "react";
import { controlChangeDescription } from "./cast";
import {
	applyConversationCommand,
	type ConversationSummary,
} from "./conversation";
import { ModelSelector } from "./ModelSelector";

// Cast-only Control selectors on the composer toolbar: `Writing as` for the
// human seat and `Responding as` for the model seat. Selecting the opposite
// seat's occupant visibly performs one atomic swap; selecting an unseated
// Participant replaces only the chosen seat. Seats can never be cleared, and
// only Cast Participants can be referenced.

interface ComposerControlSelectorsProps {
	conversation: ConversationSummary;
	disabled?: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
}

export function ComposerControlSelectors({
	conversation,
	disabled = false,
	onConversationChange,
}: ComposerControlSelectorsProps) {
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	// A transient swap/replacement description shown immediately after the
	// change so the composer visibly describes the consequence.
	const [lastChange, setLastChange] = useState<string | null>(null);

	useEffect(() => {
		if (lastChange === null) return;
		const timer = window.setTimeout(() => setLastChange(null), 4000);
		return () => window.clearTimeout(timer);
	}, [lastChange]);

	if (conversation.cast.length === 0) {
		return null;
	}

	const options = conversation.cast.map((participant) => ({
		value: participant.id,
		label: participant.duplicateLabel,
	}));

	const assign = async (seat: "human" | "model", participantId: number) => {
		if (disabled || pending) return;
		const description = controlChangeDescription(conversation, seat, participantId);
		if (description.kind === "no-change") {
			return;
		}
		setPending(true);
		setNotice(null);
		try {
			const outcome = await applyConversationCommand(
				conversation.id,
				conversation.revision,
				{ type: "assign-control", seat, participantId },
			);
			switch (outcome.status) {
				case "applied":
					onConversationChange(outcome.conversation);
					setLastChange(description.notice);
					break;
				case "conflict": {
					onConversationChange(outcome.currentConversation);
					setNotice("The Conversation changed elsewhere; the current seats were reloaded.");
					break;
				}
				case "invalid":
					setNotice(outcome.reason);
					break;
				default:
					setNotice("The Conversation could not be reached.");
			}
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="composer-controls">
			<div className="control-select">
				<label htmlFor="composer-human">Writing as</label>
				<select
					id="composer-human"
					value={conversation.control.humanParticipantId ?? ""}
					disabled={disabled || pending}
					onChange={(event) => {
						const participantId = Number(event.target.value);
						if (Number.isInteger(participantId) && participantId > 0) {
							void assign("human", participantId);
						}
					}}
				>
					{conversation.control.humanParticipantId === null && (
						<option value="">No one assigned</option>
					)}
					{options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>
			<ModelSelector
				conversation={conversation}
				disabled={disabled}
				onConversationChange={onConversationChange}
			/>
			<div className="control-select">
				<label htmlFor="composer-model">Responding as</label>
				<select
					id="composer-model"
					value={conversation.control.modelParticipantId ?? ""}
					disabled={disabled || pending}
					onChange={(event) => {
						const participantId = Number(event.target.value);
						if (Number.isInteger(participantId) && participantId > 0) {
							void assign("model", participantId);
						}
					}}
				>
					{conversation.control.modelParticipantId === null && (
						<option value="">No one assigned</option>
					)}
					{options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>
			</div>
			{(lastChange !== null || notice !== null) && (
				<p
					className={`composer-control-note${notice !== null ? " is-error" : ""}`}
					role={notice !== null ? "alert" : "status"}
				>
					{notice ?? lastChange}
				</p>
			)}
		</div>
	);
}
