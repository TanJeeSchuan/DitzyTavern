import { Sparkles, UserRound } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import type { BoxId, PromptBoxReference } from "../shared/contract/box";
import { boxClients, boxOpening, boxTitle } from "./box-windows/registry";
import { BoxIcon } from "./box-windows/BoxBoundary";
import { controlChangeDescription } from "./cast";
import {
	type ConversationSummary,
} from "./conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "./conversation-command-runner";
import { ModelSelector } from "./ModelSelector";

// @approved
//  Cast-only Control selectors on the composer toolbar: `Writing as` for the
// human seat and `Responding as` for the model seat. Selecting the opposite
// seat's occupant visibly performs one atomic swap; selecting an unseated
// Participant replaces only the chosen seat. Seats can never be cleared, and
// only Cast Participants can be referenced.

interface ComposerControlSelectorsProps {
	onOpenPanel: (panel: PromptBoxReference) => void;
	onOpenWindow: (box: BoxId) => void;
	conversation: ConversationSummary;
	disabled?: boolean;
	disabledReason?: string;
	onConversationChange: (conversation: ConversationSummary) => void;
	onControlChange: (notice: string) => void;
}

export function ComposerControlSelectors({
	onOpenPanel,
	onOpenWindow,
	conversation,
	disabled = false,
	disabledReason,
	onConversationChange,
	onControlChange,
}: ComposerControlSelectorsProps) {
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	const surface = {
		conversationId: conversation.id,
		revision: () => conversation.revision,
		onConversationChange,
		setNotice,
	};

	if (conversation.cast.length === 0) {
		return null;
	}

	//  One launcher per Box enabled in the Chat with a client entry: it opens
	//  where that Box lives. An off Box stays reachable from the Box manager,
	//  the Chat tools and the dock, where its window can be opened.
	const launchers = [...boxClients()].flatMap(([box, { icon }]) => {
		const open = conversation.boxes[box] === "enabled" ? boxOpening(box, { panel: onOpenPanel, window: onOpenWindow }) : undefined;
		return open === undefined ? [] : [{ box, icon, open }];
	});

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
			await runConversationCommand(surface, {
				type: "assign-control",
				seat,
				participantId,
			}, {
				notices: {
					conflict: "The Conversation changed elsewhere; the current seats were reloaded.",
					notFound: CONVERSATION_UNREACHABLE_NOTICE,
					unreachable: CONVERSATION_UNREACHABLE_NOTICE,
				},
				onApplied: () => onControlChange(description.notice),
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
			{launchers.map(({ box, icon, open }) => <Button key={box} type="button" variant="ghost" size="icon-sm" className="pointer-coarse:h-8" aria-label={boxTitle(box)} title={boxTitle(box)} disabled={disabled} onClick={open}><BoxIcon box={box} icon={icon} /></Button>)}
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
