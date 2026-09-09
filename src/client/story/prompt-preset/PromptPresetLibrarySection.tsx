import { useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	affectedConversationsLabel,
	presetDeletionConfirmationCopy,
	presetDeletionResultNotice,
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
	pending,
	onSelect,
	onCommand,
	onImportFile,
	onExport,
}: {
	presets: PromptPresetSummary[];
	selectedId: number;
	pending: boolean;
	onSelect: (presetId: number) => void;
	onCommand: (
		command: PromptPresetCommand,
		successNotice?: (outcome: PresetCommandOutcome) => string | null,
	) => void;
	onImportFile: (file: File) => void;
	onExport: (presetId: number, name: string) => void;
}) {
	const [creating, setCreating] = useState<string | null>(null);
	const [activeEdit, setActiveEdit] = useState<PresetInlineEdit | null>(null);
	const importInput = useRef<HTMLInputElement>(null);
	const busy = pending;
	const selected = presets.find((preset) => preset.id === selectedId);
	return (
		<section aria-label="Shared presets" className="flex flex-col gap-3">
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
					<Button
						variant="outline"
						size="sm"
						type="button"
						disabled={busy}
						onClick={() => importInput.current?.click()}
					>
						<Upload aria-hidden="true" />
						Import JSON
					</Button>
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
			<label className="flex flex-col gap-1 text-xs text-muted-foreground">
				<span>Preset for this Chat</span>
				<select
					className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm font-medium text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
					value={selectedId}
					disabled={busy || activeEdit !== null}
					onChange={(event) => {
						setActiveEdit(null);
						onSelect(Number(event.target.value));
					}}
				>
					{presets.map((preset) => (
						<option key={preset.id} value={preset.id}>
							{preset.name}{preset.isDefault ? " (Default)" : ""}
						</option>
					))}
				</select>
			</label>
			{selected !== undefined && (
				<PresetControls
					preset={selected}
					activeEdit={activeEdit?.id === selected.id ? activeEdit : null}
					busy={busy}
					onEditStart={(kind) => setActiveEdit({
						id: selected.id,
						kind,
						name: kind === "duplicate" ? `Copy of ${selected.name}` : selected.name,
					})}
					onEditDraft={(name) => setActiveEdit((current) =>
						current?.id === selected.id ? { ...current, name } : current)}
					onEditSubmit={() => {
						const edit = activeEdit;
						setActiveEdit(null);
						if (edit === null) return;
						if (edit.kind === "delete") {
							onCommand({
								type: "delete",
								presetId: selected.id,
								expectedRevision: selected.revision,
								expectedConversationCount: selected.conversationCount,
							}, (outcome) => outcome.status === "deleted"
								? presetDeletionResultNotice(selected.name, outcome.result)
								: null);
							return;
						}
						onCommand({
							type: edit.kind,
							presetId: selected.id,
							expectedRevision: selected.revision,
							name: edit.name,
						});
					}}
					onEditCancel={() => setActiveEdit(null)}
				/>
			)}
			{creating === null ? (
				<Button
					variant="outline"
					size="sm"
					type="button"
					disabled={busy}
					onClick={() => setCreating("")}
				>
					New blank preset
				</Button>
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
						onCommand({ type: "create", name });
					}}
					onCancel={() => setCreating(null)}
				/>
			)}
		</section>
	);
}

const PresetControls = ({
	preset,
	activeEdit,
	busy,
	onEditStart,
	onEditDraft,
	onEditSubmit,
	onEditCancel,
}: {
	preset: PromptPresetSummary;
	activeEdit: PresetInlineEdit | null;
	busy: boolean;
	onEditStart: (kind: PresetInlineEdit["kind"]) => void;
	onEditDraft: (name: string) => void;
	onEditSubmit: () => void;
	onEditCancel: () => void;
}) => {
	const deleteCopy = presetDeletionConfirmationCopy(preset.name, preset.conversationCount);
	return (
		<div>
			<p className="text-xs text-muted-foreground">
				{affectedConversationsLabel(preset.conversationCount)}
			</p>
			{activeEdit === null ? (
				<div className="mt-2 flex flex-wrap items-center gap-1">
					<Button variant="ghost" size="xs" type="button" disabled={busy} onClick={() => onEditStart("rename")}>Rename</Button>
					<Button variant="ghost" size="xs" type="button" disabled={busy} onClick={() => onEditStart("duplicate")}>Duplicate</Button>
					<Button variant="destructive" size="xs" type="button" disabled={busy} onClick={() => onEditStart("delete")}>Delete</Button>
				</div>
			) : activeEdit.kind === "delete" ? (
				<div className="mt-2 flex flex-col gap-2">
					<p className="text-sm text-muted-foreground">{deleteCopy.impact}</p>
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="destructive" size="xs" type="button" disabled={busy} onClick={onEditSubmit}>{deleteCopy.confirmLabel}</Button>
						<Button variant="ghost" size="xs" type="button" disabled={busy} onClick={onEditCancel}>Cancel</Button>
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
		</div>
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
			<Button size="xs" type="button" disabled={busy || !ready} onClick={onSubmit}>{submitLabel}</Button>
			<Button variant="ghost" size="xs" type="button" disabled={busy} onClick={onCancel}>Cancel</Button>
		</div>
	);
};
