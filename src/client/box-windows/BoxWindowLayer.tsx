import { Minus, X } from "lucide-react";
import { FocusScope } from "radix-ui/internal";
import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import type { BoxWindowLayout } from "../../shared/contract/box";
import type { ConversationSummary } from "../conversation";
import { useNavigationRequest } from "../SaveGuard";
import { boxTitle, boxWindow, windowBoxIds, type MoveStaging, type WindowBoxId } from "./registry";
import type { BoxWindowsController } from "./useBoxWindows";

const NARROW = "(max-width: 78rem)";
const subscribeNarrow = (onChange: () => void) => {
	const media = window.matchMedia(NARROW);
	media.addEventListener("change", onChange);
	return () => media.removeEventListener("change", onChange);
};
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

function FloatingWindow({ title, icon, size, layout, zIndex, narrow, covered, onRaise, onMove, onMinimize, onClose, children }: {
	title: string;
	icon: ReactNode;
	size: { width: number; height: number };
	layout: BoxWindowLayout;
	zIndex: number;
	narrow: boolean;
	covered: boolean;
	onRaise: () => void;
	onMove: (x: number, y: number) => void;
	onMinimize: () => void;
	onClose: () => void;
	children: ReactNode;
}) {
	const frame = useRef<HTMLElement>(null);
	const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
	const latest = useRef<{ x: number; y: number } | null>(null);
	const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		frame.current?.focus();
		return () => previous?.focus();
	}, []);
	// @approved
	//  A desktop window can be focused behind while the viewport shrinks, and a
	//  covered window comes to the top when the one above it closes; either way
	//  the visible layer is modal, so focus must move inside it.
	useEffect(() => {
		if (narrow && !covered && frame.current !== null && !frame.current.contains(document.activeElement)) frame.current.focus();
	}, [narrow, covered]);

	const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		// @approved
		//  A narrow viewport turns the window into a fixed full-screen layer;
		//  dragging is the wide-layout interaction only.
		if (event.button !== 0 || narrow) return;
		if (event.target instanceof Element && event.target.closest("button") !== null) return;
		const rect = frame.current?.getBoundingClientRect();
		if (rect === undefined) return;
		drag.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
		event.currentTarget.setPointerCapture(event.pointerId);
		onRaise();
	};
	const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		if (current === null || current.pointerId !== event.pointerId) return;
		const width = frame.current?.offsetWidth ?? 0;
		const next = {
			x: clamp(event.clientX - current.offsetX, 0, window.innerWidth - Math.min(width, window.innerWidth)),
			y: clamp(event.clientY - current.offsetY, 0, window.innerHeight - 48),
		};
		latest.current = next;
		setPosition(next);
	};
	const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		if (current === null || current.pointerId !== event.pointerId) return;
		drag.current = null;
		const next = latest.current;
		latest.current = null;
		setPosition(null);
		if (next !== null) onMove(next.x, next.y);
	};

	const x = position?.x ?? layout.x;
	const y = position?.y ?? layout.y;
	// @approved
	//  A saved position can come from a larger viewport, so the browser keeps
	//  it inside this one, on open and on every resize, with the drag's bounds.
	const style: CSSProperties = {
		zIndex,
		width: `${size.width}rem`,
		height: `${size.height}rem`,
		left: x === undefined ? undefined : `clamp(0px, ${x}px, calc(100vw - min(${size.width}rem, 100vw - 2rem)))`,
		top: y === undefined ? undefined : `clamp(0px, ${y}px, calc(100dvh - 48px))`,
	};
	return <section
		ref={frame}
		className="box-window"
		data-covered={narrow && covered ? "" : undefined}
		style={style}
		data-positioned={position !== null || (layout.x !== undefined && layout.y !== undefined)}
		role="dialog"
		aria-label={title}
		aria-modal={narrow || undefined}
		// @approved
		// On narrow the frame is the layer's first tabbable, so Tab cycling wraps from it before the trap has seen any focus.
		tabIndex={narrow ? 0 : -1}
		onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}
	>
		<div className="box-window-bar" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
			<span className="box-window-icon" aria-hidden="true">{icon}</span>
			<h2>{title}</h2>
			<div className="box-window-actions">
				<button type="button" className="box-window-action" aria-label={`Minimize ${title}`} onClick={onMinimize}>
					<Minus aria-hidden="true" />
					<span className="box-window-action-label" aria-hidden="true">Minimize</span>
				</button>
				<button type="button" className="box-window-action" aria-label={`Close ${title}`} onClick={onClose}>
					<X aria-hidden="true" />
					<span className="box-window-action-label" aria-hidden="true">Close</span>
				</button>
			</div>
		</div>
		<div className="box-window-body">{children}</div>
	</section>;
}

export function BoxWindowLayer({ conversation, controller, disabled, staging, onConversationChange }: {
	conversation: ConversationSummary | null;
	controller: BoxWindowsController;
	disabled: boolean;
	staging: MoveStaging;
	onConversationChange: (conversation: ConversationSummary) => void;
}): ReactNode {
	const requestNavigation = useNavigationRequest();
	const [order, setOrder] = useState<WindowBoxId[]>([]);
	const narrow = useSyncExternalStore(subscribeNarrow, () => window.matchMedia(NARROW).matches);
	if (conversation === null) return null;
	const running = windowBoxIds.filter((id) => conversation.boxes[id] === "enabled");
	const minimized = running.filter((id) => controller.layouts[id]?.minimized === true);
	const opened = running.filter((id) => controller.layouts[id]?.open === true && controller.layouts[id]?.minimized !== true);
	const raise = (id: WindowBoxId) => setOrder((current) => [...current.filter((entry) => entry !== id), id]);
	const zIndex = (id: WindowBoxId) => 30 + order.indexOf(id) + 1;
	// @approved
	//  The window painted last at the highest z-index is the one on top.
	const top = opened.reduce<WindowBoxId | undefined>((best, id) => best === undefined || zIndex(id) >= zIndex(best) ? id : best, undefined);
	return <>
		{minimized.length > 0 && <div className="box-dock" role="toolbar" aria-label="Minimized Boxes">
			{minimized.map((id) => {
				const { DockTab } = boxWindow(id);
				return <DockTab key={id} conversation={conversation} onRestore={() => requestNavigation(() => controller.open(id))} />;
			})}
		</div>}
		{/* @approved
		  A narrow viewport shows the top window as one full-screen layer over
		  the Chat, so focus is trapped in the layer and Tab cycles inside it;
		  the windows it covers are hidden. Wide layouts keep several non-modal
		  windows usable at once, where trapping focus would be wrong. */}
		<FocusScope.Root asChild trapped={narrow && opened.length > 0} loop={narrow && opened.length > 0}
			onMountAutoFocus={(event) => event.preventDefault()} onUnmountAutoFocus={(event) => event.preventDefault()}><div className="box-window-layer">
		{opened.map((id) => {
			const definition = boxWindow(id);
			const { Panel } = definition;
			const layout = controller.layouts[id];
			if (layout === undefined) return null;
			return <FloatingWindow
				key={id}
				title={boxTitle(id)}
				icon={<definition.icon aria-hidden="true" />}
				size={definition.size}
				layout={layout}
				zIndex={zIndex(id)}
				narrow={narrow}
				covered={id !== top}
				onRaise={() => raise(id)}
				onMove={(x, y) => controller.move(id, x, y)}
				onMinimize={() => controller.minimize(id)}
				onClose={() => requestNavigation(() => controller.close(id))}
			>
				<Panel conversation={conversation} disabled={disabled} staging={staging} onConversationChange={onConversationChange}
					boxData={(owner, key, value) => ({ type: "put-box-data", box: id, owner, key, value })} />
			</FloatingWindow>;
		})}
		</div></FocusScope.Root>
	</>;
}
