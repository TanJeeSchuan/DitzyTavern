import { Monitor, Moon, Sun } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { ReactNode } from "react";
import type { ThemePreference } from "../workspace";

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
				<SegmentedControl value={theme} onValueChange={onThemeChange} label="Appearance" options={choices.map((choice) => ({ value: choice.value, label: <>{choice.icon}{choice.label}</> }))} />
			</section>
			<section className="settings-section">
				<h3>Generation workflow</h3>
				<p>Choose whether generation pauses for review.</p>
				<div className="settings-toggle-row">
					<div>
						<strong id="prompt-plan-inspection-label">Inspect Prompt Plan before generating</strong>
						<span id="prompt-plan-inspection-description">Review and edit the exact plan before sending it to the model.</span>
					</div>
					<Switch checked={inspectPromptPlanBeforeGenerating} onCheckedChange={onInspectPromptPlanBeforeGeneratingChange} aria-labelledby="prompt-plan-inspection-label" aria-describedby="prompt-plan-inspection-description" />
				</div>
			</section>
			<p className="text-xs text-muted-foreground" role="status">Saved</p>
		</div>
	);
}
