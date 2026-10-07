import {
	BookMarked,
	Brain,
	Cable,
	ListOrdered,
	MessageSquare,
	Settings,
	SlidersHorizontal,
	Users,
} from "lucide-react";
import { Dialog } from "radix-ui";
import { useState, type ReactNode } from "react";
import type { PrimaryPanel } from "./types";

export function NavigationRail({
	activePanel,
	onOpenPanel,
}: {
	activePanel: PrimaryPanel;
	onOpenPanel: (panel: Exclude<PrimaryPanel, null>) => void;
}) {
	return (
		<nav className="navigation-rail" aria-label="Workspace">
			<div className="brand-mark" aria-label="DitzyTavern">
				DT
			</div>
			<div className="rail-actions">
				<RailButton
					label="Chats"
					active={activePanel === "chats"}
					onClick={() => onOpenPanel("chats")}
				>
					<MessageSquare aria-hidden="true" />
				</RailButton>
				<RailButton
					label="Characters"
					active={activePanel === "characters"}
					onClick={() => onOpenPanel("characters")}
				>
					<Users aria-hidden="true" />
				</RailButton>
				<RailButton
					label="Lorebooks"
					active={activePanel === "lorebooks"}
					onClick={() => onOpenPanel("lorebooks")}
				>
					<BookMarked aria-hidden="true" />
				</RailButton>
				<RailButton
					label="Prompt Presets"
					active={activePanel === "prompts"}
					onClick={() => onOpenPanel("prompts")}
				>
					<ListOrdered aria-hidden="true" />
				</RailButton>
				<RailButton
					label="Connections"
					active={activePanel === "connections"}
					onClick={() => onOpenPanel("connections")}
				>
					<Cable aria-hidden="true" />
				</RailButton>
				<RailButton
					label="Generation"
					active={activePanel === "generation"}
					onClick={() => onOpenPanel("generation")}
				>
					<SlidersHorizontal aria-hidden="true" />
				</RailButton>
				<RailButton
					label="Memory"
					active={activePanel === "memory"}
					onClick={() => onOpenPanel("memory")}
				>
					<Brain aria-hidden="true" />
				</RailButton>
			</div>
			<RailButton
				label="Settings"
				active={activePanel === "settings"}
				onClick={() => onOpenPanel("settings")}
			>
				<Settings aria-hidden="true" />
			</RailButton>
		</nav>
	);
}

// Below the desktop breakpoint the rail leaves the frame and drops down as a row under the Story header.
export function NavigationDrawer({
	open,
	onOpenChange,
	activePanel,
	onOpenPanel,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	activePanel: PrimaryPanel;
	onOpenPanel: (panel: Exclude<PrimaryPanel, null>) => void;
}) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="rail-drawer-overlay" />
				<Dialog.Content className="rail-drawer" aria-describedby={undefined}>
					<Dialog.Title className="sr-only">Workspace navigation</Dialog.Title>
					<NavigationRail
						activePanel={activePanel}
						onOpenPanel={(panel) => {
							onOpenChange(false);
							onOpenPanel(panel);
						}}
					/>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function RailButton({
	label,
	active = false,
	disabled = false,
	onClick,
	children,
}: {
	label: string;
	active?: boolean;
	disabled?: boolean;
	onClick?: () => void;
	children: ReactNode;
}) {
	const [tooltipSuppressed, setTooltipSuppressed] = useState(false);
	return (
		<button
			type="button"
			className="rail-button"
			aria-label={label}
			aria-pressed={active}
			data-tooltip-suppressed={tooltipSuppressed}
			disabled={disabled}
			onClick={() => { setTooltipSuppressed(true); onClick?.(); }}
			onPointerLeave={() => setTooltipSuppressed(false)}
		>
			{children}
			<span className="rail-label">{disabled ? `${label} unavailable` : label}</span>
		</button>
	);
}
