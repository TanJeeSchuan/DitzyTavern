import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { BoxId, BoxState } from "../../shared/contract/box";
import type { ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import { useNavigationRequest } from "../SaveGuard";
import { BoxBlockNotice, refreshPresetReads } from "./BoxBlockNotice";
import { boxTitle, listedBoxes } from "./registry";

const stateLabels = { enabled: "On", disabled: "Off · setup kept", absent: "Not in this Chat" } satisfies Record<BoxState, string>;

/** @approved The workspace's Box manager: insert, disable or remove any Box in this Chat. */
export function BoxManager({ conversation, disabled, onConversationChange }: {
	conversation: ConversationSummary;
	disabled: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
}) {
	const [pending, setPending] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);
	const [removing, setRemoving] = useState<BoxId | null>(null);
	const [requested, setRequested] = useState<{ box: BoxId; state: BoxState } | null>(null);
	const requestNavigation = useNavigationRequest();
	const client = useQueryClient();
	// @approved
	//  A change is sent once, from the first render after the save guard ran,
	//  so it carries the revision any Save and leave produced. A conflict from
	//  elsewhere reloads the Boxes in this list for the writer to
	//  review; the change is never re-applied over the newer state.
	useEffect(() => {
		if (requested === null) return;
		setRequested(null);
		setPending(true);
		setNotice(null);
		const surface = { conversationId: conversation.id, revision: () => conversation.revision, onConversationChange, setNotice };
		void runConversationCommand(surface, { type: "set-box-state", ...requested }, {
			onApplied: () => { if (requested.state === "enabled") refreshPresetReads(client); },
			notices: { conflict: "The Chat changed elsewhere; its Boxes were reloaded.", notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE },
		}).finally(() => setPending(false));
	}, [requested]);
	const setState = (box: BoxId, state: BoxState) => setRequested({ box, state });
	return <>
		<div className="panel-body box-manager">
			<p className="panel-intro">Choose which Boxes run in this Chat. Turning a Box off keeps its setup and data.</p>
			<ul aria-label="Boxes">
				{[...listedBoxes().values()].map(({ id: box, label, failure }) => {
					const state = conversation.boxes[box];
					if (state === undefined) throw new Error(`Chat ${conversation.id} has no state for Box ${box}.`);
					return <li key={box}>
						<div>
							<strong>{label}</strong>
							<span>{stateLabels[state]}</span>
							{failure !== null && <span>Did not load: {failure}</span>}
							<BoxBlockNotice conversation={conversation} box={box} disabled={disabled || pending} className="mt-1" />
						</div>
						{state !== "absent" && <Button type="button" variant="ghost" size="xs" aria-label={`Remove ${label}`} disabled={disabled || pending} onClick={() => setRemoving(box)}>Remove</Button>}
						<Switch checked={state === "enabled"} disabled={disabled || pending} aria-label={`${label} in this Chat`} onCheckedChange={(on) => setState(box, on ? "enabled" : "disabled")} />
					</li>;
				})}
			</ul>
			{notice !== null && <p className="composer-control-note is-error" role="alert">{notice}</p>}
		</div>
		<Dialog open={removing !== null} onOpenChange={(open) => { if (!open && !pending) setRemoving(null); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Remove {removing === null ? "" : boxTitle(removing)}?</DialogTitle>
					<DialogDescription>This deletes its setup and data in this Chat. Past passages and their Moves still read the same.</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" disabled={pending} onClick={() => setRemoving(null)}>Keep it</Button>
					<Button type="button" variant="destructive" disabled={pending} onClick={() => {
						const box = removing;
						setRemoving(null);
						if (box !== null) requestNavigation(() => setState(box, "absent"));
					}}>Remove</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	</>;
}
