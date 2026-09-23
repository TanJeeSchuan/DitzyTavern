import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
			<div className="flex flex-col gap-1 text-xs text-muted-foreground">
				<span id="chat-preset-label">Preset for this Chat</span>
				<Select value={String(selectedId)} disabled={pending} onValueChange={(value) => onSelect(Number(value))}>
					<SelectTrigger className="w-full font-medium" aria-labelledby="chat-preset-label"><SelectValue /></SelectTrigger>
					<SelectContent>
						{presets.map((preset) => <SelectItem key={preset.id} value={String(preset.id)}>{preset.name}{preset.isDefault ? " (Default)" : ""}</SelectItem>)}
					</SelectContent>
				</Select>
			</div>
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
