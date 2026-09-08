import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	affectedConversationsLabel,
	presetDeletionConfirmationCopy,
	presetDeletionResultNotice,
	presetSelectionFeedbackLabel,
} from "../../prompt-preset-presentation";
import type {
	PresetCommandOutcome,
	PromptPresetCommand,
	PromptPresetSummary,
} from "../../prompt-preset-library";

type PresetInlineEdit = {
	id: number;
	kind: "rename" | "duplicate" | "delete";
	name: string;
};

export function PromptPresetLibrarySection({
	presets,
	selectedId,
	pendingAction,
	onSelect,
	onCommand,
	onImportFile,
	onExport,
}: {
	presets: PromptPresetSummary[];
	selectedId: number;
	pendingAction: string | null;
	onSelect: (presetId: number) => void;
	onCommand: (
		action: string,
		command: PromptPresetCommand,
		successNotice?: (outcome: PresetCommandOutcome) => string | null,
	) => void;
	onImportFile: (file: File) => void;
	onExport: (presetId: number, name: string) => void;
}) {
	const [creating, setCreating] = useState<string | null>(null);
	const [activeEdit, setActiveEdit] = useState<PresetInlineEdit | null>(null);
	const importInput = useRef<HTMLInputElement>(null);
	const busy = pendingAction !== null;
	return (
		<section aria-label="Shared presets" className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h2 className="text-sm font-medium">Shared presets</h2>
				<div className="flex flex-wrap items-center gap-2">
					<input
						ref={importInput}
						type="file"
						accept="application/json,.json"
						className="sr-only"
						aria-label="Choose Prompt Preset or SillyTavern JSON"
						onChange={(event) => {
							const file = event.target.files?.[0];
							event.target.value = "";
							if (file !== undefined) onImportFile(file);
						}}
					/>
					<button
						className="secondary-button"
						type="button"
						disabled={busy}
						onClick={() => importInput.current?.click()}
					>
						<Upload aria-hidden="true" />
						Import JSON
					</button>
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={() => {
							const preset = presets.find((entry) => entry.id === selectedId);
							if (preset !== undefined) onExport(preset.id, preset.name);
						}}
					>
						<Download aria-hidden="true" />
						Export JSON
					</Button>
				</div>
			</div>
			<ol className="flex flex-col gap-2">
				{presets.map((preset) => (
					<PresetRow
						key={preset.id}
						preset={preset}
						isSelected={preset.id === selectedId}
						activeEdit={activeEdit?.id === preset.id ? activeEdit : null}
						busy={busy}
						onEditStart={(kind) => setActiveEdit({
							id: preset.id,
							kind,
							name: kind === "duplicate" ? `Copy of ${preset.name}` : preset.name,
						})}
						onEditDraft={(name) => setActiveEdit((current) =>
							current?.id === preset.id ? { ...current, name } : current)}
						onEditSubmit={() => {
							const edit = activeEdit;
							setActiveEdit(null);
							if (edit === null) return;
							if (edit.kind === "delete") {
								onCommand("delete", {
									type: "delete",
									presetId: preset.id,
									expectedRevision: preset.revision,
							}, (outcome) => outcome.status === "deleted"
								? presetDeletionResultNotice(preset.name, outcome.result)
								: null);
								return;
							}
							onCommand(edit.kind, {
								type: edit.kind,
								presetId: preset.id,
								expectedRevision: preset.revision,
								name: edit.name,
							});
						}}
						onEditCancel={() => setActiveEdit(null)}
						onSelect={() => onSelect(preset.id)}
					/>
				))}
			</ol>
			{creating === null ? (
				<button
					className="secondary-button justify-self-start"
					type="button"
					disabled={busy}
					onClick={() => setCreating("")}
				>
					New blank preset
				</button>
			) : (
				<InlineNameEdit
					value={creating}
					ariaLabel="New preset name"
					placeholder="Preset name"
					submitLabel="Create"
					busy={busy}
					onChange={setCreating}
					onSubmit={() => {
						const name = creating;
						setCreating(null);
						onCommand("create", { type: "create", name });
					}}
					onCancel={() => setCreating(null)}
				/>
			)}
		</section>
	);
}

const PresetRow = ({
	preset,
	isSelected,
	activeEdit,
	busy,
	onEditStart,
	onEditDraft,
	onEditSubmit,
	onEditCancel,
	onSelect,
}: {
	preset: PromptPresetSummary;
	isSelected: boolean;
	activeEdit: PresetInlineEdit | null;
	busy: boolean;
	onEditStart: (kind: PresetInlineEdit["kind"]) => void;
	onEditDraft: (name: string) => void;
	onEditSubmit: () => void;
	onEditCancel: () => void;
	onSelect: () => void;
}) => {
	const deleteCopy = presetDeletionConfirmationCopy(preset.name, preset.conversationCount);
	return (
		<li className="rounded-lg ring-1 ring-foreground/10 p-3" data-selected={isSelected}>
			<div className="flex flex-wrap items-baseline justify-between gap-2">
				<h3 className="font-medium">
					{preset.name}
					{preset.isDefault && <span className="ml-2 text-xs text-muted-foreground"> Default</span>}
				</h3>
				<span className="text-xs text-muted-foreground">
					{affectedConversationsLabel(preset.conversationCount)}
				</span>
			</div>
			{activeEdit === null ? (
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{isSelected ? (
						<span className="text-xs font-medium" aria-current="true">{presetSelectionFeedbackLabel(true)}</span>
					) : (
						<button className="secondary-button" type="button" disabled={busy} onClick={onSelect}>
							{presetSelectionFeedbackLabel(false)}
						</button>
					)}
					<button className="secondary-button" type="button" disabled={busy} onClick={() => onEditStart("rename")}>Rename</button>
					<button className="secondary-button" type="button" disabled={busy} onClick={() => onEditStart("duplicate")}>Duplicate</button>
					<button className="danger-button" type="button" disabled={busy} onClick={() => onEditStart("delete")}>Delete</button>
				</div>
			) : activeEdit.kind === "delete" ? (
				<div className="mt-2 flex flex-col gap-2">
					<p className="text-sm text-muted-foreground">{deleteCopy.impact}</p>
					<div className="flex flex-wrap items-center gap-2">
						<button className="danger-button" type="button" disabled={busy} onClick={onEditSubmit}>{deleteCopy.confirmLabel}</button>
						<button className="secondary-button" type="button" disabled={busy} onClick={onEditCancel}>Cancel</button>
					</div>
				</div>
			) : (
				<div className="mt-2">
					<InlineNameEdit
						value={activeEdit.name}
						ariaLabel={activeEdit.kind === "rename" ? `Rename ${preset.name}` : `Name the copy of ${preset.name}`}
						placeholder={activeEdit.kind === "rename" ? "Preset name" : "Copy name"}
						submitLabel={activeEdit.kind === "rename" ? "Save name" : "Duplicate"}
						busy={busy}
						onChange={onEditDraft}
						onSubmit={onEditSubmit}
						onCancel={onEditCancel}
					/>
				</div>
			)}
		</li>
	);
};

const InlineNameEdit = ({
	value,
	ariaLabel,
	placeholder,
	submitLabel,
	busy,
	onChange,
	onSubmit,
	onCancel,
}: {
	value: string;
	ariaLabel: string;
	placeholder?: string;
	submitLabel: string;
	busy: boolean;
	onChange: (value: string) => void;
	onSubmit: () => void;
	onCancel: () => void;
}) => {
	const ready = value.trim() !== "";
	return (
		<div className="flex flex-wrap items-center gap-2">
			<input
				className="definition-input"
				type="text"
				value={value}
				placeholder={placeholder}
				aria-label={ariaLabel}
				autoFocus
				onChange={(event) => onChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter" && ready) onSubmit();
					if (event.key === "Escape") onCancel();
				}}
			/>
			<button className="primary-button" type="button" disabled={busy || !ready} onClick={onSubmit}>{submitLabel}</button>
			<button className="secondary-button" type="button" disabled={busy} onClick={onCancel}>Cancel</button>
		</div>
	);
};
