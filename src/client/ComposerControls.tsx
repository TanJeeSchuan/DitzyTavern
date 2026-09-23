import { useEffect, useState } from "react";
import { AppSelect } from "@/components/ui/select";
import { controlChangeDescription } from "./cast";
import {
	applyConversationCommand,
	type ConversationSummary,
} from "./conversation";
import { runConversationCommand } from "./conversation-command-runner";
import { CONVERSATION_UNREACHABLE_NOTICE } from "./lib/command-outcome";
import { ModelSelector } from "./ModelSelector";

// ==[HUMAN APPROVED]== Cast-only Control selectors on the composer toolbar: `Writing as` for the
// human seat and `Responding as` for the model seat. Selecting the opposite
// seat's occupant visibly performs one atomic swap; selecting an unseated
// Participant replaces only the chosen seat. Seats can never be cleared, and
// only Cast Participants can be referenced.

interface ComposerControlSelectorsProps {
	conversation: ConversationSummary;
	disabled?: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
	onModelSelectionChange: (connectionProfileId: number, modelId: string) => void;
}

export function ComposerControlSelectors({
	conversation,
	disabled = false,
	onConversationChange,
	onModelSelectionChange,
}: ComposerControlSelectorsProps) {
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	// ==[HUMAN APPROVED]== A transient swap/replacement description shown immediately after the
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
		const showUnreachable = () => setNotice(CONVERSATION_UNREACHABLE_NOTICE);
		try {
			await runConversationCommand({
				revision: () => conversation.revision,
				send: (expectedRevision) =>
					applyConversationCommand(conversation.id, expectedRevision, {
						type: "assign-control",
						seat,
						participantId,
					}),
				reconciliation: {
					adoptSnapshot: onConversationChange,
					showNotice: setNotice,
				},
				notices: {
					conflict: "The Conversation changed elsewhere; the current seats were reloaded.",
					notFound: CONVERSATION_UNREACHABLE_NOTICE,
					unreachable: CONVERSATION_UNREACHABLE_NOTICE,
				},
				callbacks: {
					onApplied: () => setLastChange(description.notice),
					onNotPlayable: showUnreachable,
					onNotRemovable: showUnreachable,
				},
			});
		} finally {
			setPending(false);
		}
	};

	return (
		<div className="composer-controls">
			<div className="control-select">
				<label htmlFor="composer-human">Writing as</label>
				<AppSelect
					id="composer-human"
					value={conversation.control.humanParticipantId ?? ""}
					disabled={disabled || pending}
					emptyLabel={conversation.control.humanParticipantId === null ? "No one assigned" : undefined}
					options={options.map((option) => ({ ...option, label: option.value === conversation.control.modelParticipantId ? `${option.label} · Swap seats` : option.label }))}
					onValueChange={(value) => {
						const participantId = Number(value);
						if (Number.isInteger(participantId) && participantId > 0) {
							void assign("human", participantId);
						}
					}}
				/>
			</div>
			<ModelSelector
				conversation={conversation}
				disabled={disabled}
				 onConversationChange={onConversationChange}
				onSelectionChange={onModelSelectionChange}
			/>
			<div className="control-select">
				<label htmlFor="composer-model">Responding as</label>
				<AppSelect
					id="composer-model"
					value={conversation.control.modelParticipantId ?? ""}
					disabled={disabled || pending}
					emptyLabel={conversation.control.modelParticipantId === null ? "No one assigned" : undefined}
					options={options.map((option) => ({ ...option, label: option.value === conversation.control.humanParticipantId ? `${option.label} · Swap seats` : option.label }))}
					onValueChange={(value) => {
						const participantId = Number(value);
						if (Number.isInteger(participantId) && participantId > 0) {
							void assign("model", participantId);
						}
					}}
				/>
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
