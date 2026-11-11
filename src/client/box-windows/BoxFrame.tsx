/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Moves, commits and files a guest sends arrive as whatever it posted, which the frame's host code checks. */
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { useQuery } from "@tanstack/react-query";
import { Box, Coins, Dices, Drama, Flag, Gauge, Heart, Map, Scroll, Sparkles, Star, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { boxMetadata, type BoxDescriptor, type BoxId } from "../../shared/contract/box";
import { sandboxedCommit, sandboxedDescriptor, sandboxedRead, type SandboxedBoxIcon, type SandboxedDescriptorFile } from "../../shared/contract/box-sandboxed";
import type { BoxValue } from "../../shared/contract/box-value";
import { replaceMoves } from "../../shared/contract/box-generation";
import { MAX_IMAGE_BYTES } from "../../shared/contract/image";
import { boxFrameRoute } from "../../shared/box-frame";
import type { ConversationSummary } from "../conversation";
import { runConversationCommand } from "../conversation-command-runner";
import { api } from "../lib/eden";
import { requestOutcome } from "../lib/request-outcome";
import { notFoundOutcome } from "../../shared/contract/outcomes";
import { encodeImage } from "../lib/image";
import { useSaveGuard } from "../SaveGuard";
import { BoxFailure } from "./BoxBoundary";
import type { AppToFrame, FrameToApp } from "./frame-protocol";
import { delegateLens } from "./lens";
import { digestWindow } from "./PassageTimeline";
import type { BoxClientDefinition, MoveStaging } from "./registry";
import { useBoxRead } from "./useBoxRead";

/** @approved The icon each name a sandboxed Box may give in its descriptor stands for. */
const icons = {
	box: Box, coins: Coins, dice: Dices, drama: Drama, flag: Flag, gauge: Gauge, heart: Heart, map: Map, scroll: Scroll, sparkles: Sparkles, star: Star,
} satisfies Record<SandboxedBoxIcon, LucideIcon>;

const noMoves: readonly BoxValue[] = [];
/** @approved How long the window waits for a guest to answer a save request before it counts as not saved. */
const SAVE_ANSWER_MS = 10_000;

// @approved
//  Moves a guest staged, as this Box's composer may take them: a JSON copy
// that passes the Box's Move schema and count, or why they were refused. A
// cyclic or other non-JSON value never reaches the composer, whose query
// keys hash its Moves.
export const stagedMoves = (descriptor: BoxDescriptor, staged: unknown): { readonly moves: readonly BoxValue[] } | { readonly refused: string } => {
	const declared = descriptor.moves;
	if (declared === undefined) return { refused: "It staged Moves, but it takes none." };
	let copy: unknown;
	try {
		copy = JSON.parse(JSON.stringify(staged));
	} catch {
		return { refused: "It staged Moves that are not JSON." };
	}
	return Value.Check(Type.Array(Type.Unsafe<BoxValue>(declared.schema), { maxItems: declared.max }), copy) ? { moves: copy } : { refused: "It staged Moves that do not match its Move schema." };
};

/** @approved A sandboxed Box's `ui.js` or `ui.css`, a version's at its own URL; the server answers an absent `ui.css` with an empty stylesheet. */
const uiFile = async (box: BoxId, version: string | undefined, file: string) => {
	const response = await fetch(version === undefined ? `/boxes/${box}/${file}` : `/boxes/${box}/versions/${version}/${file}`);
	if (!response.ok) throw new Error(`Its ${file} did not load: ${response.status}.`);
	return await response.text();
};

// @approved
//  Runs `task` unless an earlier run of it is still in flight, which answers
// `busy` at once instead of queuing: a frame uploads one image at a time.
export const oneAtATime = <Input, Output>(task: (input: Input) => Promise<Output>, busy: () => Output) => {
	let running = false;
	return async (input: Input): Promise<Output> => {
		if (running) return busy();
		running = true;
		try { return await task(input); } finally { running = false; }
	};
};

const useSandboxedRead = (conversation: ConversationSummary, box: BoxId) => useBoxRead(conversation, box, sandboxedRead);
const refused = (reason: string) => ({ outcome: "refused", reason } as const);

type FrameProps = { box: BoxId; version: string | undefined; descriptor: BoxDescriptor; conversation: ConversationSummary; disabled: boolean; staging: MoveStaging | null; onConversationChange: (conversation: ConversationSummary) => void };

// @approved
//  A sandboxed Box's window: a frame with no privileges whose document only
// the host writes, and whose guest code runs in a Worker. The app opens the
// frame under a token bound to this Box and Chat, and talks to it over the
// port it hands the frame on each load: the guest's `ui.js` and `ui.css`
// once, then every read with this Box's staged Moves, whether controls are
// disabled, whether the read is stale and its snapshot. What the guest asks
// for, the app does for this Box and Chat only: staged Moves replace this
// Box's own under its schema, count and enabled rules; a commit runs as
// `commit-box` at the snapshot it names, and one that does not land answers
// with the current read; an upload, one at a time, is stored and granted to
// this Box; and its unsaved work joins the window's save guard. A Worker
// failure shows in the window. Tearing the frame down closes its token. A
// versioned Box's frame runs one version: its token, its commits and its
// uploads name it, the server refuses them once the Chat pins another, and
// it stages no Moves for a Chat that moved on.
function BoxFrame(props: FrameProps) {
	const { box, version, conversation } = props;
	const frame = useRef<HTMLIFrameElement>(null);
	const [token, setToken] = useState<string>();
	const [port, setPort] = useState<MessagePort>();
	const [failure, setFailure] = useState<string>();
	const [dirty, setDirty] = useState(false);
	const ui = useQuery({ queryKey: [box, "ui", version ?? null], queryFn: async () => ({ ui: await uiFile(box, version, "ui.js"), css: await uiFile(box, version, "ui.css") }), staleTime: Infinity });
	const read = useSandboxedRead(conversation, box);
	const staged = props.staging === null ? null : props.staging.moves[box] ?? noMoves;
	const latest = useRef({ props, read, token });
	latest.current = { props, read, token };
	const saves = useRef(new globalThis.Map<number, (saved: boolean) => void>());
	const nextSave = useRef(0);
	useEffect(() => {
		let current = true;
		let opened: string | undefined;
		const close = (closing: string) => void api.api["box-frame"]({ token: closing }).delete();
		setToken(undefined);
		void api.api.conversations({ id: conversation.id }).boxes({ box }).frame.post({ version }).then(({ data }) => {
			if (data === null) setFailure("Its frame could not be opened.");
			else if (current) setToken(opened = data.token);
			else close(data.token);
		});
		return () => {
			current = false;
			if (opened !== undefined) close(opened);
		};
	}, [box, version, conversation.id]);
	const connect = () => {
		const channel = new MessageChannel();
		frame.current?.contentWindow?.postMessage(null, "*", [channel.port2]);
		setPort(channel.port1);
	};
	useEffect(() => () => port?.close(), [port]);
	useEffect(() => {
		if (ui.data !== undefined) port?.postMessage({ type: "start", ...ui.data } satisfies AppToFrame);
	}, [port, ui.data]);
	useEffect(() => {
		const data = read.data;
		if (ui.data === undefined || data === undefined || data === null) return;
		port?.postMessage({ type: "read", read: data.view, view: { moves: staged, disabled: props.disabled, stale: read.isPlaceholderData, snapshot: data.snapshot } } satisfies AppToFrame);
	}, [port, ui.data, read.data, read.isPlaceholderData, staged, props.disabled]);
	useSaveGuard({
		dirty,
		save: () => new Promise<boolean>((resolve) => {
			const id = nextSave.current++;
			const settle = (saved: boolean) => { saves.current.delete(id); resolve(saved); };
			saves.current.set(id, settle);
			setTimeout(() => settle(false), SAVE_ANSWER_MS);
			port?.postMessage({ type: "save", id } satisfies AppToFrame);
		}),
		discard: () => port?.postMessage({ type: "discard" } satisfies AppToFrame),
	});
	useEffect(() => {
		if (port === undefined) return;
		const reply = (id: unknown, result: unknown) => { if (typeof id === "number") port.postMessage({ type: "reply", id, result } satisfies AppToFrame); };
		port.onmessage = ({ data }: MessageEvent<FrameToApp>) => {
			const { props: { descriptor, staging, disabled, conversation: current }, token: frameToken } = latest.current;
			if (data.type === "error") setFailure(data.message);
			if (data.type === "dirty") setDirty(data.dirty === true);
			if (data.type === "saved" && typeof data.id === "number") saves.current.get(data.id)?.(data.saved === true);
			if (data.type === "commit") void commit(data.commit).then((result) => reply(data.id, result));
			if (data.type === "upload") void upload({ file: data.file, frameToken }).then((result) => reply(data.id, result));
			if (data.type !== "stage") return;
			if (current.boxVersions[box] !== version) {
				setFailure("It staged Moves for a version this Chat no longer runs.");
				return;
			}
			if (staging === null || disabled) {
				setFailure(disabled ? "It staged Moves while its controls are off." : "It staged Moves while it cannot take them.");
				return;
			}
			const accepted = stagedMoves(descriptor, data.moves);
			if ("refused" in accepted) setFailure(accepted.refused);
			else staging.onChange(replaceMoves(staging.moves, box, accepted.moves));
		};
	}, [port, box]);
	const commit = async (request: unknown) => {
		const { props: { disabled, onConversationChange, conversation: { id: conversationId } } } = latest.current;
		if (disabled) return refused("Its controls are off.");
		if (!Value.Check(sandboxedCommit, request)) return refused("It sent a commit the host cannot read.");
		const { snapshot, ...action } = request;
		let reason = "";
		let conflict = false;
		const applied = await runConversationCommand(
			{ conversationId, revision: () => snapshot, exact: true, onConversationChange, setNotice: (notice) => { reason = notice; } },
			{ type: "commit-box", box, ...latest.current.props.version !== undefined && { version: latest.current.props.version }, ...action },
			{ notices: { conflict: "The Chat changed since this window read it." }, onConflict: () => { conflict = true; } },
		);
		if (applied) {
			const current = await requestOutcome(api.api.conversations({ id: conversationId }).boxes({ box }).get(), sandboxedRead, notFoundOutcome);
			if (current.outcome !== "available") return { ...refused("Its saved state could not be read."), current: null };
			const { props } = latest.current;
			// A guest may discard its draft on acknowledgement, so deliver the saved read first on the same port.
			const moves = props.staging === null ? null : props.staging.moves[box] ?? noMoves;
			port?.postMessage({ type: "read", read: current.value.view, view: { moves, disabled: props.disabled, stale: false, snapshot: current.value.snapshot } } satisfies AppToFrame);
			return { outcome: "applied" } as const;
		}
		const current = await latest.current.read.refetch();
		return { outcome: conflict ? "conflict" : "refused", reason, current: current.data ?? null } as const;
	};
	const upload = useRef(oneAtATime(async ({ file, frameToken }: { file: unknown; frameToken: string | undefined }) => {
		if (!(file instanceof Blob)) return refused("It uploaded something that is not a file.");
		if (file.size > MAX_IMAGE_BYTES) return refused(`The image is over ${MAX_IMAGE_BYTES / 1024 / 1024} MiB.`);
		if (frameToken === undefined) return refused("Its frame is not open.");
		const { data, error } = await api.api["box-frame"]({ token: frameToken }).images.post({ data: await encodeImage(file) });
		return error === null ? { outcome: "uploaded", hash: data.hash } as const : refused(error.status === 422 ? error.value.reason : "The image could not be saved.");
	}, () => refused("It is already uploading an image."))).current;
	const shown = ui.error?.message ?? read.error?.message ?? failure;
	return <>
		{shown !== undefined && <BoxFailure box={box} message={shown} />}
		{token !== undefined && <iframe ref={frame} className="box-frame" title={boxMetadata(box).label} sandbox="allow-scripts" src={`${boxFrameRoute}/${token}`} onLoad={connect} />}
	</>;
}

/** @approved A sandboxed Box's Status: the line its read returns, its label when it returns none. */
function SandboxedStatus({ box, conversation }: { box: BoxId; conversation: ConversationSummary }) {
	const read = useSandboxedRead(conversation, box);
	return <span>{read.isError ? "Unavailable" : read.data?.status ?? boxMetadata(box).label}</span>;
}

/** @approved A sandboxed Box's client surfaces, built in host code from its descriptor file: its icon, its Status and a window that mounts its frame, with the host's lens for a delegating Box's tag, or, for a digesting Box, the host's passage timeline. */
export const sandboxedClient = (box: BoxId, file: SandboxedDescriptorFile, version?: string): BoxClientDefinition => {
	const descriptor = sandboxedDescriptor(file);
	if (descriptor.id !== box) throw new Error(`Its descriptor is the ${descriptor.id} Box's.`);
	if (file.window.kind === "digest") return { descriptor, ...digestWindow(descriptor, { icon: icons[file.window.icon], size: file.window.size, ...version !== undefined && { version } }) };
	return {
		descriptor,
		icon: icons[file.window.icon],
		Status: ({ conversation }) => <SandboxedStatus box={box} conversation={conversation} />,
		Window: { size: file.window.size, ...descriptor.delegate !== undefined && { lens: delegateLens(descriptor.delegate.tag) }, Panel: ({ conversation, disabled, staging, onConversationChange }) =>
			<BoxFrame box={box} version={version} descriptor={descriptor} conversation={conversation} disabled={disabled} staging={staging} onConversationChange={onConversationChange} /> },
	};
};
