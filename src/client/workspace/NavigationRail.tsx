import {
	BookOpen,
	BookMarked,
	Cpu,
	ListOrdered,
	MessageSquare,
	Settings,
	SlidersHorizontal,
	Users,
} from "lucide-react";
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
					label="Cast"
					active={activePanel === "cast"}
					onClick={() => onOpenPanel("cast")}
				>
					<Users aria-hidden="true" />
				</RailButton>
				<RailButton
					label="Library"
					active={activePanel === "library"}
					onClick={() => onOpenPanel("library")}
				>
					<BookOpen aria-hidden="true" />
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
					label="Models"
					active={activePanel === "models"}
					onClick={() => onOpenPanel("models")}
				>
					<Cpu aria-hidden="true" />
				</RailButton>
				<RailButton
					label="Generation"
					active={activePanel === "generation"}
					onClick={() => onOpenPanel("generation")}
				>
					<SlidersHorizontal aria-hidden="true" />
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
