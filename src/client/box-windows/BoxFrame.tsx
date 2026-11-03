/* eslint-disable anti-slop/no-unknown-parameters -- Moves a guest stages arrive as whatever it posted, which stagedMoves parses. */
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { useQuery } from "@tanstack/react-query";
import { Box, Coins, Dices, Flag, Gauge, Heart, Map, Scroll, Sparkles, Star, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { boxMetadata, type BoxDescriptor, type BoxId } from "../../shared/contract/box";
import { sandboxedDescriptor, type SandboxedBoxIcon, type SandboxedDescriptorFile } from "../../shared/contract/box-sandboxed";
import { boxValue, type BoxValue } from "../../shared/contract/box-value";
import { replaceMoves } from "../../shared/contract/box-generation";
import { boxFrameRoute } from "../../shared/box-frame";
import type { ConversationSummary } from "../conversation";
import { BoxFailure } from "./BoxBoundary";
import type { AppToFrame, FrameToApp } from "./frame-protocol";
import type { BoxClientDefinition, MoveStaging } from "./registry";
import { useBoxRead } from "./useBoxRead";

/** @approved The icon each name a sandboxed Box may give in its descriptor stands for. */
const icons = {
	box: Box, coins: Coins, dice: Dices, flag: Flag, gauge: Gauge, heart: Heart, map: Map, scroll: Scroll, sparkles: Sparkles, star: Star,
} satisfies Record<SandboxedBoxIcon, LucideIcon>;

const noMoves: readonly BoxValue[] = [];

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

const uiFile = async (box: BoxId, file: string, required: boolean) => {
	const response = await fetch(`/boxes/${box}/${file}`);
	if (response.ok) return await response.text();
	if (required || response.status !== 404) throw new Error(`Its ${file} did not load: ${response.status}.`);
	return "";
};

// @approved
//  A sandboxed Box's window: a frame with no privileges whose document only
// the host writes, and whose guest code runs in a Worker. The app talks to it
// over the port it hands the frame on each load: the guest's `ui.js` and
// `ui.css` once, then every read with this Box's staged Moves and whether
// controls are disabled. The frame sends back Moves the guest stages, which
// replace this Box's own under its schema, count and enabled rules, and a
// failure of the guest's Worker, which shows in the window.
function BoxFrame({ box, descriptor, conversation, disabled, staging }: {
	box: BoxId;
	descriptor: BoxDescriptor;
	conversation: ConversationSummary;
	disabled: boolean;
	staging: MoveStaging | null;
}) {
	const frame = useRef<HTMLIFrameElement>(null);
	const [port, setPort] = useState<MessagePort>();
	const [failure, setFailure] = useState<string>();
	const ui = useQuery({ queryKey: [box, "ui"], queryFn: async () => ({ ui: await uiFile(box, "ui.js", true), css: await uiFile(box, "ui.css", false) }), staleTime: Infinity });
	const read = useBoxRead(conversation, box, boxValue);
	const staged = staging === null ? null : staging.moves[box] ?? noMoves;
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
		if (ui.data !== undefined && read.data !== undefined && read.data !== null) port?.postMessage({ type: "read", read: read.data, moves: staged, disabled } satisfies AppToFrame);
	}, [port, ui.data, read.data, staged, disabled]);
	useEffect(() => {
		if (port === undefined) return;
		port.onmessage = ({ data }: MessageEvent<FrameToApp>) => {
			if (data.type === "error") {
				setFailure(data.message);
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
	}, [port, staging, disabled, descriptor, box]);
	const shown = ui.error?.message ?? read.error?.message ?? failure;
	return <>
		{shown !== undefined && <BoxFailure box={box} message={shown} />}
		<iframe ref={frame} className="box-frame" title={boxMetadata(box).label} sandbox="allow-scripts" src={boxFrameRoute} onLoad={connect} />
	</>;
}

/** @approved A sandboxed Box's client surfaces, built in host code from its descriptor file: its icon and a window that mounts its frame. */
export const sandboxedClient = (box: BoxId, file: SandboxedDescriptorFile): BoxClientDefinition => {
	const descriptor = sandboxedDescriptor(file);
	if (descriptor.id !== box) throw new Error(`Its descriptor is the ${descriptor.id} Box's.`);
	return {
		descriptor,
		icon: icons[file.window.icon],
		Window: { size: file.window.size, Panel: ({ conversation, disabled, staging }) => <BoxFrame box={box} descriptor={descriptor} conversation={conversation} disabled={disabled} staging={staging} /> },
	};
};
