import {
	BookOpen,
	MessageSquare,
	Settings,
	Users,
} from "lucide-react";
import type { ReactNode } from "react";
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
	return (
		<button
			type="button"
			className="rail-button"
			aria-label={label}
			aria-pressed={active}
			disabled={disabled}
			onClick={onClick}
		>
			{children}
			<span className="rail-label">{disabled ? `${label} unavailable` : label}</span>
		</button>
	);
}

