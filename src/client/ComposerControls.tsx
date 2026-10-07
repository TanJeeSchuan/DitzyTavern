import { NotebookPen, Sparkles, UserRound } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { controlChangeDescription } from "./cast";
import {
	applyConversationCommand,
	type ConversationSummary,
} from "./conversation";
import { runConversationCommand } from "./conversation-command-runner";
import { CONVERSATION_UNREACHABLE_NOTICE } from "./lib/notices";
import { ModelSelector } from "./ModelSelector";

// ==[HUMAN APPROVED]== Cast-only Control selectors on the composer toolbar: `Writing as` for the
// human seat and `Responding as` for the model seat. Selecting the opposite
// seat's occupant visibly performs one atomic swap; selecting an unseated
// Participant replaces only the chosen seat. Seats can never be cleared, and
// only Cast Participants can be referenced.

interface ComposerControlSelectorsProps {
	onAuthorNote: () => void;
	conversation: ConversationSummary;
	disabled?: boolean;
	disabledReason?: string;
	onConversationChange: (conversation: ConversationSummary) => void;
	onControlChange: (notice: string) => void;
}

export function ComposerControlSelectors({
	onAuthorNote,
	conversation,
	disabled = false,
	disabledReason,
	onConversationChange,
	onControlChange,
}: ComposerControlSelectorsProps) {
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

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
					onApplied: () => onControlChange(description.notice),
					onNotPlayable: showUnreachable,
					onNotRemovable: showUnreachable,
				},
			});
		} finally {
			setPending(false);
		}
	};

	const seatSelect = (seat: "human" | "model", label: string, icon: ReactNode, suffix?: string) => {
		const id = `composer-${seat}`;
		const seated = seat === "human" ? conversation.control.humanParticipantId : conversation.control.modelParticipantId;
		const opposite = seat === "human" ? conversation.control.modelParticipantId : conversation.control.humanParticipantId;
		return (
			<>
				<label htmlFor={id} className="sr-only">{label}</label>
				<Select
					value={seated === null ? undefined : String(seated)}
					disabled={disabled || pending}
					onValueChange={(value) => void assign(seat, Number(value))}
				>
					<SelectTrigger id={id} className="control-select-trigger focus-visible:ring-0">
						{icon}
						<SelectValue placeholder="No one assigned" />
						{suffix !== undefined && <span className="control-select-suffix" aria-hidden="true">{suffix}</span>}
					</SelectTrigger>
					<SelectContent position="popper" side="top" align="start" sideOffset={-1} className="control-select-menu shadow-none ring-0 data-[side=top]:translate-y-0">
						{options.map((option) => (
							<SelectItem key={option.value} value={String(option.value)}>
								{option.label}
								{option.value === opposite && <span className="control-select-swap" title="Swap seats"><span aria-hidden="true">⇄</span><span className="sr-only">swap seats</span></span>}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</>
		);
	};

	return (
		<div className="composer-controls">
			<Button type="button" variant="ghost" size="icon-sm" aria-label="Author Note" title="Author Note" disabled={disabled} onClick={onAuthorNote}><NotebookPen aria-hidden="true" /></Button>
			{seatSelect("human", "Writing as", <UserRound aria-hidden="true" />)}
			<ModelSelector
				conversation={conversation}
				disabled={disabled}
				disabledReason={disabledReason}
				onConversationChange={onConversationChange}
			/>
			{seatSelect("model", "Responding as", <Sparkles aria-hidden="true" />, "replies")}
			{notice !== null && <p className="composer-control-note is-error" role="alert">{notice}</p>}
		</div>
	);
}
