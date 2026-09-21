import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type {
	PresetCommandOutcome,
	PromptPresetCommand,
	PromptPresetSummary,
} from "../../prompt-preset-library";
import { PromptPresetManagerDialog } from "./PromptPresetManagerDialog";

export function PromptPresetLibrarySection({
	presets,
	selectedId,
	pending,
	problem,
	notice,
	onSelect,
	onCommand,
	onImportFile,
	onExport,
}: {
	presets: PromptPresetSummary[];
	selectedId: number;
	pending: boolean;
	problem: string | null;
	notice: string | null;
	onSelect: (presetId: number) => void;
	onCommand: (
		command: PromptPresetCommand,
		successNotice?: (outcome: PresetCommandOutcome) => string | null,
	) => void;
	onImportFile: (file: File) => void;
	onExport: (presetId: number, name: string) => void;
}) {
	return (
		<section aria-label="Prompt Preset selection" className="flex flex-col gap-3">
			<label className="flex flex-col gap-1 text-xs text-muted-foreground">
				<span>Preset for this Chat</span>
				<select
					className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
					value={selectedId}
					disabled={pending}
					onChange={(event) => onSelect(Number(event.target.value))}
				>
					{presets.map((preset) => (
						<option key={preset.id} value={preset.id}>
							{preset.name}{preset.isDefault ? " (Default)" : ""}
						</option>
					))}
				</select>
			</label>
			<PromptPresetManagerDialog
				presets={presets}
				selectedId={selectedId}
				pending={pending}
				problem={problem}
				notice={notice}
				onCommand={onCommand}
				onImportFile={onImportFile}
				onExport={onExport}
				trigger={(
					<Button variant="outline" size="sm" type="button" disabled={pending}>
						<Settings2 aria-hidden="true" />
						Manage shared presets
					</Button>
				)}
			/>
		</section>
	);
}
