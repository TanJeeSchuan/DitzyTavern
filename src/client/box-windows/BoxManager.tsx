import { useQueryClient } from "@tanstack/react-query";
import { Ellipsis } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { boxMetadata, type BoxId, type BoxState, type PromptBoxReference } from "../../shared/contract/box";
import type { ConversationSummary } from "../conversation";
import { useNavigationRequest } from "../SaveGuard";
import { BoxBlockNotice, sendBoxState } from "./BoxBlockNotice";
import { BoxBoundary, BoxIcon } from "./BoxBoundary";
import type { CreateBox as Panel } from "./CreateBox";
import { addBoxClients, boxOpening, errorMessage, loadedBoxes, type LoadedBox } from "./registry";

// @approved
//  Creator Mode loads when it is first opened, with its code highlighting. A
// load that fails, such as an old tab asking for a chunk a deploy removed,
// shows why in place of the panel and dismisses like it; the rest of the Box
// manager keeps working.
const CreateBox = lazy(() => import("./CreateBox").then(({ CreateBox: panel }) => ({ default: panel }), (cause) => ({
	default: ({ onOpenChange }: ComponentProps<typeof Panel>) => <p className="composer-control-note is-error mx-3" role="alert">
		Create a Box did not load: {errorMessage(cause)} Reload the page to try again.{" "}
		<Button type="button" variant="ghost" size="xs" onClick={() => onOpenChange(false)}>Dismiss</Button>
	</p>,
})));

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
	const [creating, setCreating] = useState(false);
	const [, setRegistry] = useState(0);
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
		void sendBoxState(surface, client, requested.box, requested.state).finally(() => setPending(false));
	}, [requested]);
	const setState = (box: BoxId, state: BoxState) => setRequested({ box, state });
	// @approved
	//  An installed Box joins every Chat as absent: every cached Chat is read
	// again first, inactive ones included, so no Chat renders a summary that
	// predates the Box once its client definition is added and the manager
	// lists it to add. A Chat that fails to refresh stops it there, before the
	// definition is added, since that Chat would render without the Box; the
	// Box is installed all the same, and a reload shows it.
	const addInstalled = async () => {
		await client.invalidateQueries({ queryKey: ["conversation"], refetchType: "all" }, { throwOnError: true }).catch((cause: Error) => {
			throw new Error(`The Box is installed, but the Chats did not refresh (${cause.message}). Reload the page to add it.`);
		});
		await addBoxClients();
		setRegistry((count) => count + 1);
	};

	const stateOf = (box: BoxId) => {
		const state = conversation.boxes[box];
		if (state === undefined) throw new Error(`Chat ${conversation.id} has no state for Box ${box}.`);
		return state;
	};
	const rows = [...loadedBoxes()].map(([box, loaded]) => ({ box, loaded, state: stateOf(box) }));
	const inChat = rows.filter(({ state }) => state !== "absent");
	const toAdd = rows.filter(({ state }) => state === "absent");

	const row = ({ box, loaded, state }: { readonly box: BoxId; readonly loaded: LoadedBox; readonly state: BoxState }) => {
		const { label, summary } = loaded.metadata;
		const clientModule = "client" in loaded ? loaded.client : undefined;
		const Status = clientModule?.Status;
		const locked = disabled || pending;
		const open = state === "absent" ? undefined : boxOpening(box, { panel: onOpenPanel, window: onOpenWindow });
		const status = Status === undefined ? undefined : <BoxBoundary box={box}><Status conversation={conversation} /></BoxBoundary>;
		const statusLine = state === "absent" ? summary : status ?? summary;
		return <li key={box} data-state={state}>
			<span className="box-manager-icon" aria-hidden="true">{clientModule !== undefined && <BoxIcon box={box} icon={clientModule.icon} />}</span>
			<div className="box-manager-copy">
				{open === undefined ? <strong>{label}</strong> : <button type="button" className="box-manager-name" onClick={open}>{label}</button>}
				<span className="box-manager-status" title={state === "absent" ? undefined : summary}>{statusLine}</span>
				{"failure" in loaded && <span className="box-manager-status box-failure">Did not load: {loaded.failure}</span>}
				<BoxBlockNotice conversation={conversation} box={box} disabled={locked} className="mt-1" />
			</div>
			{state === "absent"
				? <Button type="button" variant="outline" size="xs" aria-label={`Add ${label}`} disabled={locked} onClick={() => setState(box, "enabled")}>Add</Button>
				: <>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="ghost" size="icon-sm" className="box-manager-actions" aria-label={`${label} actions`}><Ellipsis aria-hidden="true" /></Button>
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
			<Button type="button" variant="outline" size="sm" className="box-manager-create" onClick={() => setCreating(true)}>Create a Box</Button>
		</div>
		{creating && <Suspense fallback={null}><CreateBox open onOpenChange={setCreating} onInstalled={addInstalled} /></Suspense>}
		<Dialog open={removing !== null} onOpenChange={(open) => { if (!open && !pending) setRemoving(null); }}>
			<DialogContent showCloseButton={false} className="sm:max-w-sm">
				<DialogHeader>
					<DialogTitle>Remove {removing === null ? "" : boxMetadata(removing).label}?</DialogTitle>
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
