import { Boxes } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { boxIds, type BoxId, type BoxState } from "../../shared/contract/box";
import type { ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import { useNavigationRequest } from "../SaveGuard";
import { boxTitle } from "./registry";

const stateLabels = { enabled: "On", disabled: "Off · setup kept", absent: "Not in this Chat" } satisfies Record<BoxState, string>;

/** @approved The composer's Box manager: insert, disable or remove any Box in this Chat. */
export function BoxManager({ conversation, disabled, onConversationChange }: {
	conversation: ConversationSummary;
	disabled: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
}) {
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [removing, setRemoving] = useState<BoxId | null>(null);
	const requestNavigation = useNavigationRequest();
	const setState = async (box: BoxId, state: BoxState) => {
		setPending(true);
		setNotice(null);
		// @approved
		//  The state is absolute, so one conflict re-applies it on the current
		//  revision: Save and leave from the save guard moves the revision first.
		let current: ConversationSummary | undefined;
		const run = (revision: number) =>
			runConversationCommand({ conversationId: conversation.id, revision: () => revision, onConversationChange, setNotice }, { type: "set-box-state", box, state }, {
				notices: { conflict: "The Chat changed elsewhere; its Boxes were reloaded.", notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE },
				onConflict: (latest) => { current = latest; },
			});
		try {
			await run(conversation.revision);
			if (current !== undefined) {
				setNotice(null);
				await run(current.revision);
			}
		} finally {
			setPending(false);
		}
	};
	return <>
		<Popover onOpenChange={() => setNotice(null)}>
			<PopoverTrigger asChild>
				<Button type="button" variant="ghost" size="icon-sm" aria-label="Boxes" title="Boxes" disabled={disabled}><Boxes aria-hidden="true" /></Button>
			</PopoverTrigger>
			<PopoverContent side="top" align="start" className="box-manager">
				<PopoverHeader><PopoverTitle>Boxes in this Chat</PopoverTitle></PopoverHeader>
				<ul aria-label="Boxes">
					{boxIds.map((box) => {
						const state = conversation.boxes[box];
						return <li key={box}>
							<div>
								<strong>{boxTitle(box)}</strong>
								<span>{stateLabels[state]}</span>
							</div>
							{state !== "absent" && <Button type="button" variant="ghost" size="xs" aria-label={`Remove ${boxTitle(box)}`} disabled={pending} onClick={() => setRemoving(box)}>Remove</Button>}
							<Switch checked={state === "enabled"} disabled={pending} aria-label={`${boxTitle(box)} in this Chat`} onCheckedChange={(on) => on ? void setState(box, "enabled") : requestNavigation(() => void setState(box, "disabled"))} />
						</li>;
					})}
				</ul>
				{notice !== null && <p className="composer-control-note is-error" role="alert">{notice}</p>}
			</PopoverContent>
		</Popover>
		<Dialog open={removing !== null} onOpenChange={(open) => { if (!open && !pending) setRemoving(null); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Remove {removing === null ? "" : boxTitle(removing)}?</DialogTitle>
					<DialogDescription>This deletes its setup and data in this Chat. Past passages and their Moves still read the same.</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" disabled={pending} onClick={() => setRemoving(null)}>Keep it</Button>
					<Button type="button" variant="destructive" disabled={pending} onClick={() => { const box = removing; setRemoving(null); if (box !== null) requestNavigation(() => void setState(box, "absent")); }}>Remove</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	</>;
}
