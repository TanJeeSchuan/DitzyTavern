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
import type { PrimaryPanel, PrimaryPanelName } from "./types";

export function NavigationRail({
	activePanel,
	inspecting,
	onOpenPanel,
}: {
	activePanel: PrimaryPanel;
	inspecting: boolean;
	onOpenPanel: (panel: PrimaryPanelName) => void;
}) {
	return (
		<nav className="navigation-rail" aria-label="Workspace">
			<div className="brand-mark" aria-label="DitzyTavern">
				DT
			</div>
			<div className="rail-actions">
				<RailButton
					disabled={inspecting}
					label="Chats"
					active={activePanel === "chats"}
					onClick={() => onOpenPanel("chats")}
				>
					<MessageSquare aria-hidden="true" />
				</RailButton>
				<RailButton
					disabled={inspecting}
					label="Characters"
					active={activePanel === "characters"}
					onClick={() => onOpenPanel("characters")}
				>
					<Users aria-hidden="true" />
				</RailButton>
				<RailButton
					disabled={inspecting}
					label="Lorebooks"
					active={activePanel === "lorebooks"}
					onClick={() => onOpenPanel("lorebooks")}
				>
					<BookMarked aria-hidden="true" />
				</RailButton>
				<RailButton
					disabled={inspecting}
					label="Prompt Presets"
					active={activePanel === "prompts"}
					onClick={() => onOpenPanel("prompts")}
				>
					<ListOrdered aria-hidden="true" />
				</RailButton>
				<RailButton
					disabled={inspecting}
					label="Connections"
					active={activePanel === "connections"}
					onClick={() => onOpenPanel("connections")}
				>
					<Cable aria-hidden="true" />
				</RailButton>
				<RailButton
					disabled={inspecting}
					label="Generation"
					active={activePanel === "generation"}
					onClick={() => onOpenPanel("generation")}
				>
					<SlidersHorizontal aria-hidden="true" />
				</RailButton>
				<RailButton
					disabled={inspecting}
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

// @approved
// Below the desktop breakpoint the rail leaves the frame and drops down as a row under the Story header.
export function NavigationDrawer({
	open,
	onOpenChange,
	activePanel,
	inspecting,
	onOpenPanel,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	activePanel: PrimaryPanel;
	inspecting: boolean;
	onOpenPanel: (panel: PrimaryPanelName) => void;
}) {
	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="rail-drawer-overlay" />
				<Dialog.Content className="rail-drawer" aria-describedby={undefined}>
					<Dialog.Title className="sr-only">Workspace navigation</Dialog.Title>
					<NavigationRail
						activePanel={activePanel}
						inspecting={inspecting}
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
