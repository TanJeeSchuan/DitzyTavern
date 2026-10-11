import { Minus, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type PointerEvent as ReactPointerEvent } from "react";
import type { BoxWindowLayout } from "../../shared/contract/box";
import type { ConversationSummary } from "../conversation";
import { useNavigationRequest } from "../SaveGuard";
import { boxWindows, windowBoxIds, type MoveStaging, type WindowBoxId } from "./registry";
import type { BoxWindowsController } from "./useBoxWindows";

const NARROW = "(max-width: 78rem)";
const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

const useNarrowLayout = (): boolean => {
	const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
	useEffect(() => {
		const media = window.matchMedia(NARROW);
		const update = () => setNarrow(media.matches);
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, []);
	return narrow;
};

function FloatingWindow({ title, icon, size, layout, zIndex, onRaise, onMove, onMinimize, onClose, children }: {
	title: string;
	icon: ReactNode;
	size: { width: number; height: number };
	layout: BoxWindowLayout;
	zIndex: number;
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
	const narrow = useNarrowLayout();
	useEffect(() => {
		const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		frame.current?.focus();
		return () => previous?.focus();
	}, []);
	// @approved
	//  A desktop window can be focused behind while the viewport shrinks; when
	//  the layer becomes modal, focus must move inside it.
	useEffect(() => {
		if (narrow && frame.current !== null && !frame.current.contains(document.activeElement)) frame.current.focus();
	}, [narrow]);

	// @approved
	//  A narrow viewport shows one full-screen layer over the Chat, so Tab must
	//  cycle inside it; wide layouts keep several non-modal windows usable at
	//  once, where trapping focus would be wrong.
	const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
		if (event.key === "Escape") { event.stopPropagation(); onClose(); return; }
		if (!narrow || event.key !== "Tab") return;
		const focusable = frame.current === null ? [] : [...frame.current.querySelectorAll<HTMLElement>(FOCUSABLE)]
			.filter((element) => element.offsetParent !== null && element.tabIndex >= 0);
		const first = focusable[0];
		const last = focusable.at(-1);
		if (first === undefined || last === undefined) { event.preventDefault(); frame.current?.focus(); return; }
		if (event.shiftKey && (document.activeElement === first || document.activeElement === frame.current)) { event.preventDefault(); last.focus(); }
		else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
	};

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

	const style: CSSProperties = {
		zIndex,
		width: `${size.width}rem`,
		height: `${size.height}rem`,
		left: position?.x ?? layout.x,
		top: position?.y ?? layout.y,
	};
	return <section
		ref={frame}
		className="box-window"
		style={style}
		data-positioned={position !== null || (layout.x !== undefined && layout.y !== undefined)}
		role="dialog"
		aria-label={title}
		aria-modal={narrow || undefined}
		tabIndex={-1}
		onKeyDown={handleKeyDown}
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
	if (conversation === null) return null;
	const minimized = windowBoxIds.filter((id) => controller.layouts[id]?.minimized === true);
	const opened = windowBoxIds.filter((id) => controller.layouts[id]?.open === true && controller.layouts[id]?.minimized !== true);
	const raise = (id: WindowBoxId) => setOrder((current) => [...current.filter((entry) => entry !== id), id]);
	return <>
		{minimized.length > 0 && <div className="box-dock" role="toolbar" aria-label="Minimized Boxes">
			{minimized.map((id) => {
				const definition = boxWindows[id];
				return <definition.DockTab key={id} conversation={conversation} onRestore={() => requestNavigation(() => controller.open(id))} />;
			})}
		</div>}
		{opened.map((id) => {
			const definition = boxWindows[id];
			const layout = controller.layouts[id];
			if (layout === undefined) return null;
			return <FloatingWindow
				key={id}
				title={definition.title}
				icon={<definition.icon aria-hidden="true" />}
				size={definition.size}
				layout={layout}
				zIndex={30 + order.indexOf(id) + 1}
				onRaise={() => raise(id)}
				onMove={(x, y) => controller.move(id, x, y)}
				onMinimize={() => controller.minimize(id)}
				onClose={() => requestNavigation(() => controller.close(id))}
			>
				<definition.Panel conversation={conversation} disabled={disabled} staging={staging} onConversationChange={onConversationChange} />
			</FloatingWindow>;
		})}
	</>;
}
