import { useQueryClient } from "@tanstack/react-query";
import { Ellipsis } from "lucide-react";
import { lazy, Suspense, useEffect, useState, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { authoringSessions } from "../../shared/contract/authoring";
import { boxMetadata, type BoxId, type BoxState, type PromptBoxReference } from "../../shared/contract/box";
import { api } from "../lib/eden";
import { requestData } from "../lib/request-outcome";
import type { ConversationSummary } from "../conversation";
import { useNavigationRequest } from "../SaveGuard";
import { BoxBlockNotice, sendBoxState } from "./BoxBlockNotice";
import { BoxBoundary, BoxIcon } from "./BoxBoundary";
import type { CreateBox as Panel } from "./CreateBox";
import { addBoxClients, boxOpening, refreshLatest, chatBoxClient, chatBoxVersion, errorMessage, loadedBoxes, type LoadedBox } from "./registry";
import { CONVERSATION_UNREACHABLE_NOTICE, runConversationCommand } from "../conversation-command-runner";

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
	const [requested, setRequested] = useState<{ box: BoxId; state: BoxState } | { box: BoxId; version: string } | null>(null);
	const [creating, setCreating] = useState<{ readonly reopen?: string } | null>(null);
	const [authored, setAuthored] = useState<ReadonlyMap<string, string>>(new Map());
	// @approved
	//  A Box installed from Creator Mode links back to the session that made
	// it only through that session's saved meta: the newest session that
	// installed each Box id, read when the manager opens, offers to open it.
	// A Box with no session, or a manager that cannot read them, offers
	// nothing more.
	const [, setRegistry] = useState(0);
	// @approved
	//  Opening the manager also reads each listed Box's `latest` again, so a
	// version another tab installed shows here as "Update available".
	useEffect(() => {
		requestData(api.api.authoring.sessions.get(), authoringSessions).then(({ sessions }) => {
			setAuthored(new Map(sessions.filter(({ installed }) => installed).toReversed().map(({ box, session }) => [box, session])));
		}, () => undefined);
		refreshLatest().then(() => setRegistry((count) => count + 1), () => undefined);
	}, []);
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
		const sent = "state" in requested ? sendBoxState(surface, client, requested.box, requested.state)
			: runConversationCommand(surface, { type: "upgrade-box", box: requested.box, version: requested.version }, {
				notices: { conflict: "The Chat changed elsewhere; its Boxes were reloaded.", notFound: CONVERSATION_UNREACHABLE_NOTICE, unreachable: CONVERSATION_UNREACHABLE_NOTICE },
			});
		void sent.finally(() => setPending(false));
	}, [requested]);
	const setState = (box: BoxId, state: BoxState) => setRequested({ box, state });
	// @approved
	//  Update moves this Chat to the Box's `latest` through the upgrade check.
	// It remounts the Box's window on the new version, so it asks the save
	// guard first, as leaving would; a refusal lists each place that no longer
	// fits, and nothing changes.
	const update = (box: BoxId, version: string) => requestNavigation(() => setRequested({ box, version }));
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
		const clientModule = chatBoxClient(conversation, box);
		const updateTo = conversation.boxVersions[box] !== undefined && chatBoxVersion(conversation, box) !== loaded.version ? loaded.version : undefined;
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
				{updateTo !== undefined && <span className="box-manager-status">Update available</span>}
				<BoxBlockNotice conversation={conversation} box={box} disabled={locked} className="mt-1" />
			</div>
			{updateTo !== undefined && <Button type="button" variant="outline" size="xs" aria-label={`Update ${label}`} disabled={locked} onClick={() => update(box, updateTo)}>Update</Button>}
			{state === "absent"
				? <Button type="button" variant="outline" size="xs" aria-label={`Add ${label}`} disabled={locked} onClick={() => setState(box, "enabled")}>Add</Button>
				: <>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button type="button" variant="ghost" size="icon-sm" className="box-manager-actions" aria-label={`${label} actions`}><Ellipsis aria-hidden="true" /></Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-44">
							{open !== undefined && <DropdownMenuItem onSelect={open}>Open {label}</DropdownMenuItem>}
							{authored.has(box) && <DropdownMenuItem onSelect={() => setCreating({ reopen: authored.get(box) })}>Open its session</DropdownMenuItem>}
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
			{notice !== null && <p className="composer-control-note is-error whitespace-pre-line" role="alert">{notice}</p>}
			<Button type="button" variant="outline" size="sm" className="box-manager-create" onClick={() => setCreating({})}>Create a Box</Button>
		</div>
		{creating !== null && <Suspense fallback={null}><CreateBox open reopen={creating.reopen} onOpenChange={(next) => { if (!next) setCreating(null); }} onInstalled={addInstalled} /></Suspense>}
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
