import { useRef, useState, type ReactNode } from "react";
import { Download, Plus, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
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

const conversationUsageLabel = (count: number): string =>
	count === 0 ? "None" : `${count} ${count === 1 ? "Chat" : "Chats"}`;

export function PromptPresetManagerDialog({
	presets,
	selectedId,
	pending,
	problem,
	notice,
	onCommand,
	onImportFile,
	onExport,
	trigger,
}: {
	presets: PromptPresetSummary[];
	selectedId: number;
	pending: boolean;
	problem: string | null;
	notice: string | null;
	onCommand: (
		command: PromptPresetCommand,
		successNotice?: (outcome: PresetCommandOutcome) => string | null,
	) => void;
	onImportFile: (file: File) => void;
	onExport: (presetId: number, name: string) => void;
	trigger: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [managedId, setManagedId] = useState(selectedId);
	const [creating, setCreating] = useState<string | null>(null);
	const [activeEdit, setActiveEdit] = useState<PresetInlineEdit | null>(null);
	const importInput = useRef<HTMLInputElement>(null);
	const selected = presets.find((preset) => preset.id === selectedId);
	const managed = presets.find((preset) => preset.id === managedId) ?? selected ?? presets[0];

	const changeOpen = (next: boolean) => {
		setOpen(next);
		setActiveEdit(null);
		setCreating(null);
		if (next) setManagedId(selectedId);
	};

	return (
		<Dialog open={open} onOpenChange={changeOpen}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Manage shared presets</DialogTitle>
					<DialogDescription>
						Create and maintain presets available to every Chat. Choosing a preset here does not change the current Chat.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4">
					<div className="overflow-hidden rounded-lg border border-border">
						<table className="w-full table-fixed text-left text-sm">
							<thead className="bg-muted/50 text-xs text-muted-foreground">
								<tr>
									<th className="px-3 py-2 font-medium" scope="col">Preset</th>
									<th className="w-24 px-3 py-2 font-medium sm:w-32" scope="col">Used by</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-border">
								{presets.map((preset) => {
									const isManaged = managed?.id === preset.id;
									return (
										<tr key={preset.id} className={isManaged ? "bg-primary/8" : "hover:bg-muted/30"}>
											<td className="p-0">
												<button
													type="button"
													className="w-full px-3 py-2.5 text-left font-medium outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
													aria-pressed={isManaged}
													disabled={pending || activeEdit !== null}
													onClick={() => {
														setActiveEdit(null);
														setManagedId(preset.id);
													}}
												>
													{preset.name}
												</button>
											</td>
											<td className="px-3 py-2.5 text-muted-foreground">
												{conversationUsageLabel(preset.conversationCount)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<input
							ref={importInput}
							type="file"
							accept="application/json,.json"
							className="sr-only"
							aria-label="Choose a Prompt Preset or SillyTavern JSON file to import"
							onChange={(event) => {
								const file = event.target.files?.[0];
								event.target.value = "";
								if (file === undefined) return;
								changeOpen(false);
								onImportFile(file);
							}}
						/>
						{creating === null ? (
							<Button variant="outline" size="sm" className="pl-1.5" type="button" disabled={pending} onClick={() => setCreating("")}>
								<Plus aria-hidden="true" />
								New preset
							</Button>
						) : (
							<InlineNameEdit
								value={creating}
								ariaLabel="New preset name"
								placeholder="Preset name"
								submitLabel="Create"
								busy={pending}
								onChange={setCreating}
								onSubmit={() => {
									const name = creating;
									setCreating(null);
									onCommand({ type: "create", name });
								}}
								onCancel={() => setCreating(null)}
							/>
						)}
						<Button variant="outline" size="sm" type="button" disabled={pending} onClick={() => importInput.current?.click()}>
							<Upload aria-hidden="true" />
							Import
						</Button>
					</div>
					{managed !== undefined && (
						<div className="border-t border-border pt-4">
							<PresetControls
								preset={managed}
								activeEdit={activeEdit?.id === managed.id ? activeEdit : null}
								busy={pending}
								onExport={() => onExport(managed.id, managed.name)}
								onEditStart={(kind) => setActiveEdit({
									id: managed.id,
									kind,
									name: kind === "duplicate" ? `Copy of ${managed.name}` : managed.name,
								})}
								onEditDraft={(name) => setActiveEdit((current) =>
									current?.id === managed.id ? { ...current, name } : current)}
								onEditSubmit={() => {
									const edit = activeEdit;
									setActiveEdit(null);
									if (edit === null) return;
									if (edit.kind === "delete") {
										onCommand({
											type: "delete",
											presetId: managed.id,
											expectedRevision: managed.revision,
											expectedConversationCount: managed.conversationCount,
										}, (outcome) => outcome.status === "deleted"
											? presetDeletionResultNotice(managed.name, outcome.result)
											: null);
										return;
									}
									onCommand({
										type: edit.kind,
										presetId: managed.id,
										expectedRevision: managed.revision,
										name: edit.name,
									});
								}}
								onEditCancel={() => setActiveEdit(null)}
							/>
						</div>
					)}
					{problem !== null && (
						<p className="text-sm text-destructive" role="alert">{problem}</p>
					)}
					{problem === null && notice !== null && (
						<p className="text-sm text-muted-foreground" role="status">{notice}</p>
					)}
				</div>
				<DialogFooter showCloseButton />
			</DialogContent>
		</Dialog>
	);
}

const PresetControls = ({
	preset,
	activeEdit,
	busy,
	onExport,
	onEditStart,
	onEditDraft,
	onEditSubmit,
	onEditCancel,
}: {
	preset: PromptPresetSummary;
	activeEdit: PresetInlineEdit | null;
	busy: boolean;
	onExport: () => void;
	onEditStart: (kind: PresetInlineEdit["kind"]) => void;
	onEditDraft: (name: string) => void;
	onEditSubmit: () => void;
	onEditCancel: () => void;
}) => {
	const deleteCopy = presetDeletionConfirmationCopy(preset.name, preset.conversationCount);
	return (
		<div>
			<p className="text-sm">
				<span className="text-muted-foreground">Selected: </span>
				<span className="font-medium">{preset.name}</span>
			</p>
			{activeEdit === null ? (
				<div className="mt-3 flex flex-wrap items-center justify-between gap-2">
					<div className="flex flex-wrap items-center gap-1">
						<Button variant="ghost" size="xs" type="button" disabled={busy} onClick={() => onEditStart("rename")}>Rename</Button>
						<Button variant="ghost" size="xs" type="button" disabled={busy} onClick={() => onEditStart("duplicate")}>Duplicate</Button>
						<Button variant="ghost" size="xs" type="button" disabled={busy} onClick={onExport}>
							<Download aria-hidden="true" />
							Export
						</Button>
					</div>
					<Button variant="destructive" size="xs" type="button" disabled={busy} onClick={() => onEditStart("delete")}>Delete</Button>
				</div>
			) : activeEdit.kind === "delete" ? (
				<div className="mt-3 flex flex-col gap-2">
					<p className="text-sm text-muted-foreground">{deleteCopy.impact}</p>
					<div className="flex flex-wrap items-center gap-2">
						<Button variant="destructive" size="xs" type="button" disabled={busy} onClick={onEditSubmit}>{deleteCopy.confirmLabel}</Button>
						<Button variant="ghost" size="xs" type="button" disabled={busy} onClick={onEditCancel}>Cancel</Button>
					</div>
				</div>
			) : (
				<div className="mt-3">
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
			<Input
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
