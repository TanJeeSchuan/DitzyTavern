import { Check, Monitor, Moon, Sun } from "lucide-react";
import { Switch } from "radix-ui";
import type { ReactNode } from "react";
import type { ThemePreference } from "../workspace";
import { EmbeddingSettingsEditor } from "./EmbeddingSettingsEditor";

export function SettingsPanel({
	theme,
	onThemeChange,
	inspectPromptPlanBeforeGenerating,
	onInspectPromptPlanBeforeGeneratingChange,
}: {
	theme: ThemePreference;
	onThemeChange: (theme: ThemePreference) => void;
	inspectPromptPlanBeforeGenerating: boolean;
	onInspectPromptPlanBeforeGeneratingChange: (enabled: boolean) => void;
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
			<section className="settings-section">
				<h3>Generation workflow</h3>
				<p>Choose whether generation pauses for review.</p>
				<div className="settings-toggle-row">
					<div>
						<strong id="prompt-plan-inspection-label">Inspect Prompt Plan before generating</strong>
						<span id="prompt-plan-inspection-description">Review and edit the exact plan before sending it to the model.</span>
					</div>
					<Switch.Root className="settings-switch" checked={inspectPromptPlanBeforeGenerating} onCheckedChange={onInspectPromptPlanBeforeGeneratingChange} aria-labelledby="prompt-plan-inspection-label" aria-describedby="prompt-plan-inspection-description">
						<Switch.Thumb className="settings-switch-thumb" />
					</Switch.Root>
				</div>
			</section>
			<EmbeddingSettingsEditor />
		</div>
	);
}
