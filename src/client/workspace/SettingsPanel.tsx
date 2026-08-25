import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import type { ThemePreference } from "../workspace";
import { ConnectionSettingsPanel } from "./ConnectionSettingsPanel";

export function SettingsPanel({
	theme,
	onThemeChange,
}: {
	theme: ThemePreference;
	onThemeChange: (theme: ThemePreference) => void;
}) {
	const choices: Array<{
		value: ThemePreference;
		label: string;
		icon: ReactNode;
	}> = [
		{ value: "system", label: "System", icon: <Monitor aria-hidden="true" /> },
		{ value: "daylight", label: "Daylight", icon: <Sun aria-hidden="true" /> },
		{ value: "evening", label: "Evening", icon: <Moon aria-hidden="true" /> },
	];

	return (
		<div className="panel-body settings-panel-body">
			<section>
				<h3>Appearance</h3>
				<p>Choose how the writing room responds to your display.</p>
				<div className="theme-options">
					{choices.map((choice) => (
						<button
							type="button"
							key={choice.value}
							data-active={theme === choice.value}
							onClick={() => onThemeChange(choice.value)}
						>
							{choice.icon}
							<span>{choice.label}</span>
							{theme === choice.value && <Check aria-hidden="true" />}
						</button>
					))}
				</div>
			</section>
			<ConnectionSettingsPanel />
		</div>
	);
}

