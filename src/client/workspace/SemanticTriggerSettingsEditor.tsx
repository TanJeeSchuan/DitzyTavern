import { Slider } from "@/components/ui/slider";
import { loadSemanticTriggerSettings, saveSemanticTriggerSettings, type SemanticTriggerSettings } from "../semantic-trigger-settings";
import { DecisionSettingsEditor, useSettingsDraft, type SettingsDraft } from "./DecisionSettingsEditor";

export const useSemanticTriggerSettings = () => useSettingsDraft("Semantic Trigger Settings", loadSemanticTriggerSettings, saveSemanticTriggerSettings);

export function SemanticTriggerSettingsEditor({ semanticTriggers, onBack }: { semanticTriggers: SettingsDraft<SemanticTriggerSettings>; onBack: () => void }) {
	return (
		<DecisionSettingsEditor
			editor={semanticTriggers}
			id="semantic-trigger-settings"
			title="Semantic Triggers"
			description="Choose a Decision Model to match Lore Entries by their Semantic Triggers. Clear the selection for keyword-only matching."
			pickerLabel="Semantic Trigger Decision Model"
			pickerHelper="System One connections only. Memory has its own selection."
			stateDescription="Long scenes are split so the model reads the whole Lore Scan Window."
			onBack={onBack}
		>
			{(draft) => (
				<div className="grid gap-1.5">
					<div className="flex items-center justify-between gap-3">
						<label htmlFor="semanticTriggers-threshold" className="text-[13px] font-medium text-muted-foreground">Trigger threshold</label>
						<span className="text-[13px] tabular-nums">{draft.triggerThreshold.toFixed(2)}</span>
					</div>
					<Slider
						id="semanticTriggers-threshold"
						className="py-1.5 [&_[data-slot=slider-track]]:bg-foreground/15"
						min={0}
						max={1}
						step={0.05}
						disabled={draft.decisionProfileId === null}
						value={[draft.triggerThreshold]}
						onValueChange={([triggerThreshold]) => {
							if (triggerThreshold !== undefined) semanticTriggers.update({ triggerThreshold });
						}}
						aria-label="Trigger threshold"
					/>
					<small className="text-xs text-muted-foreground">The Decision Model's probability that a trigger's situation happens in the scene. Starts at 0.50.</small>
				</div>
			)}
		</DecisionSettingsEditor>
	);
}
