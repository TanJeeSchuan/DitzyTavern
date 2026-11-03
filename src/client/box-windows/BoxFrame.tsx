import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { useQuery } from "@tanstack/react-query";
import { Box, Coins, Dices, Flag, Gauge, Heart, Map, Scroll, Sparkles, Star, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { boxMetadata, type BoxDescriptor, type BoxId } from "../../shared/contract/box";
import { sandboxedDescriptor, type SandboxedDescriptorFile, sandboxedBoxIcons } from "../../shared/contract/box-sandboxed";
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
} satisfies Record<(typeof sandboxedBoxIcons)[number], LucideIcon>;

const noMoves: readonly BoxValue[] = [];

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
	const read = useBoxRead(conversation, box, boxValue).data;
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
		if (ui.data !== undefined && read !== undefined && read !== null) port?.postMessage({ type: "read", read, moves: staged, disabled } satisfies AppToFrame);
	}, [port, ui.data, read, staged, disabled]);
	useEffect(() => {
		if (port === undefined) return;
		const moves = descriptor.moves && Type.Array(Type.Unsafe<BoxValue>(descriptor.moves.schema), { maxItems: descriptor.moves.max });
		port.onmessage = ({ data }: MessageEvent<FrameToApp>) => {
			if (data.type === "error") setFailure(data.message);
			else if (staging === null || moves === undefined) setFailure("It staged Moves while it cannot take them.");
			else if (!Value.Check(moves, data.moves)) setFailure("It staged Moves that do not match its Move schema.");
			else staging.onChange(replaceMoves(staging.moves, box, data.moves));
		};
	}, [port, staging, descriptor, box]);
	const shown = ui.error?.message ?? failure;
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
