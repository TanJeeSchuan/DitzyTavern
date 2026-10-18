import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import type { BoxId, BoxState, PromptBoxReference } from "../../shared/contract/box";
import type { ConversationSummary } from "../conversation";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";
import { useNavigationRequest } from "../SaveGuard";
import { BoxBlockNotice, refreshPresetReads } from "./BoxBlockNotice";
import { BoxBoundary, BoxIcon } from "./BoxBoundary";
import { boxClients, boxOpening, boxTitle, listedBoxes, type ListedBox } from "./registry";

/** The workspace's Box manager: the Boxes in this Chat, then the ones to add. */
export function BoxManager({ conversation, disabled, onConversationChange, onOpenPanel, onOpenWindow }: {
	conversation: ConversationSummary;
	disabled: boolean;
	onConversationChange: (conversation: ConversationSummary) => void;
	onOpenPanel: (panel: PromptBoxReference) => void;
	onOpenWindow: (box: BoxId) => void;
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

	const stateOf = ({ id: box }: ListedBox) => {
		const state = conversation.boxes[box];
		if (state === undefined) throw new Error(`Chat ${conversation.id} has no state for Box ${box}.`);
		return state;
	};
	const rows = [...listedBoxes().values()].map((box) => ({ box, state: stateOf(box) }));
	const inChat = rows.filter(({ state }) => state !== "absent");
	const toAdd = rows.filter(({ state }) => state === "absent");

	const row = ({ box: listed, state }: { readonly box: ListedBox; readonly state: BoxState }) => {
		const { id: box, label, summary, failure } = listed;
		const clientModule = boxClients().get(box);
		const Status = clientModule?.Status;
		const locked = disabled || pending;
		const open = state === "absent" ? undefined : boxOpening(box, { panel: onOpenPanel, window: onOpenWindow });
		const status = Status === undefined ? undefined : <BoxBoundary box={box}><Status conversation={conversation} /></BoxBoundary>;
		const statusLine = state === "absent" ? summary
			: status === undefined ? (state === "enabled" ? "On" : "Off")
			: state === "enabled" ? status : <>Off · {status}</>;
		return <li key={box} data-off={state !== "enabled" || undefined}>
			<span className="box-manager-icon" aria-hidden="true">{clientModule !== undefined && <BoxIcon box={box} icon={clientModule.icon} />}</span>
			<div className="box-manager-copy">
				{open === undefined ? <strong>{label}</strong> : <button type="button" className="box-manager-name" onClick={open}>{label}</button>}
				<span className="box-manager-status">{statusLine}</span>
				{failure !== null && <span className="box-manager-status">Did not load: {failure}</span>}
				<BoxBlockNotice conversation={conversation} box={box} disabled={locked} className="mt-1" />
			</div>
			{state === "absent"
				? <Button type="button" variant="outline" size="xs" aria-label={`Add ${label}`} disabled={locked} onClick={() => setState(box, "enabled")}>Add</Button>
				: <>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="ghost" size="icon-sm" className="box-manager-actions" aria-label={`${label} actions`}>⋯</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-44">
							{open !== undefined && <DropdownMenuItem onSelect={open}>Open {label}</DropdownMenuItem>}
							<DropdownMenuItem variant="destructive" onSelect={() => setRemoving(box)}>Remove from Chat…</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
					<Switch checked={state === "enabled"} disabled={locked} aria-label={`${label} in this Chat`} onCheckedChange={(on) => setState(box, on ? "enabled" : "disabled")} />
				</>}
		</li>;
	};

	return <>
		<div className="panel-body box-manager" role="group" aria-label="Boxes">
			{inChat.length > 0 && <section aria-labelledby="box-manager-in-chat">
				<h3 id="box-manager-in-chat">In this Chat</h3>
				<ul>{inChat.map(row)}</ul>
			</section>}
			{toAdd.length > 0 && <section aria-labelledby="box-manager-add">
				<h3 id="box-manager-add">Add to this Chat</h3>
				<ul>{toAdd.map(row)}</ul>
			</section>}
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
