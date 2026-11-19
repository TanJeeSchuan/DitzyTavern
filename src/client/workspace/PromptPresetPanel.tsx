import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ConversationPromptPreset, PromptPresetSummary } from "../../shared/contract/prompt-preset";
import type { ConversationSummary } from "../conversation";
import { PanelHeader } from "../PanelHeader";
import { SaveFooter } from "../SaveFooter";
import { useNavigationRequest, useSaveGuard } from "../SaveGuard";
import { PromptPresetLibrarySection } from "./prompt-preset/PromptPresetLibrarySection";
import { PromptPresetRecipeEditor } from "./prompt-preset/PromptPresetRecipeEditor";
import { PromptPresetImportReviewDialog } from "./prompt-preset/PromptPresetImportReviewDialog";
import { presetLibraryQuery, presetRecipeQuery, usePromptPresetEditor } from "./prompt-preset/usePromptPresetEditor";

type PanelProps = {
	conversation: ConversationSummary | null;
	presetId?: number;
	onConversationChange: (conversation: ConversationSummary | null) => void;
	onClose: () => void;
	mutationsDisabled?: boolean;
};

export function PromptPresetPanel({ conversation, presetId, onConversationChange, onClose, mutationsDisabled = false }: PanelProps) {
	const navigate = useNavigationRequest();
	const paint = presetId !== undefined;
	return (
		<>
			<PanelHeader
				title={paint ? "Paint / Paint Preset" : "Prompt Presets"}
				nested={paint}
				backLabel={paint ? "Back to Paint" : "Back to Chat"}
				onClose={paint ? () => navigate(onClose) : onClose}
			/>
			{conversation === null ? <LoadingPresets /> : <PresetQueries
				key={`${conversation.id}:${presetId ?? "story"}`}
				conversation={conversation}
				presetId={presetId}
				mutationsDisabled={mutationsDisabled}
				onConversationChange={onConversationChange}
			/>}
		</>
	);
}

type PresetProps = {
	conversation: ConversationSummary;
	presetId: number | undefined;
	mutationsDisabled: boolean;
	onConversationChange: PanelProps["onConversationChange"];
};

function PresetQueries(props: PresetProps) {
	const { conversation, presetId } = props;
	const [notice, setNotice] = useState<string | null>(null);
	const library = useQuery(presetLibraryQuery);
	const recipe = useQuery({ ...presetRecipeQuery(conversation.id, conversation.revision, presetId), placeholderData: keepPreviousData });
	const preset = recipe.isError ? null : recipe.data ?? null;
	const [draftPresetId, setDraftPresetId] = useState(preset?.id);
	if (preset !== null && !recipe.isPlaceholderData && preset.id !== draftPresetId) setDraftPresetId(preset.id);
	return <PresetEditor key={draftPresetId} {...props} presets={library.data} preset={preset}
		recipePending={recipe.isPlaceholderData} readFailed={library.isLoadingError || recipe.isError || recipe.data === null}
		notice={notice} onNotice={setNotice} />;
}

function LoadingPresets() {
	return <div className="panel-body" role="status">
		<span className="sr-only">Loading the Prompt Preset library…</span>
		<ol aria-hidden="true" className="flex flex-col gap-3">
			{Array.from({ length: 4 }, (_, index) => (
				<li key={index} className="h-16 animate-pulse rounded-lg bg-muted/50 ring-1 ring-foreground/10" />
			))}
		</ol>
	</div>;
}

function PresetEditor({ mutationsDisabled, presets, preset, recipePending, readFailed, notice, ...props }: PresetProps & {
	presets: PromptPresetSummary[] | undefined;
	preset: ConversationPromptPreset | null;
	recipePending: boolean;
	readFailed: boolean;
	notice: string | null;
	onNotice: (notice: string | null) => void;
}) {
	const canSave = presets !== undefined && preset !== null && !recipePending;
	const editor = usePromptPresetEditor({ ...props, preset, recipePending: !canSave });
	const navigate = useNavigationRequest();
	const busy = editor.busy !== null;
	const pending = busy || recipePending;
	useSaveGuard({ dirty: editor.dirty, saving: busy, canSave, save: editor.save, discard: editor.discard });

	if (presets === undefined || preset === null) {
		return readFailed
			? <p className="panel-body text-muted-foreground">The Prompt Preset library could not be loaded.</p>
			: <LoadingPresets />;
	}
	return (
		<>
			<div className="panel-body flex flex-col gap-6" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
				{props.presetId === undefined ? <PromptPresetLibrarySection
					presets={presets}
					selectedId={preset.id}
					pending={pending}
					problem={editor.problem}
					notice={notice}
					onSelect={(id) => navigate(() => void editor.applySelection(id))}
					onCommand={(command, successNotice) => void editor.runPresetCommand(command, successNotice)}
					onImportFile={(file) => void editor.importPresetFile(file)}
					onExport={(id, name) => void editor.exportSelectedPreset(id, name)}
				/> : <p className="font-medium">{preset.name}</p>}
				<PromptPresetRecipeEditor
					preset={preset}
					drafts={editor.drafts}
					pending={pending}
					editingDisabled={editor.busy === "change" || recipePending}
					problem={editor.problem}
					onDraftChange={editor.setDraft}
					onEnabledChange={editor.setEnabled}
					onDraftCancel={editor.clearDraft}
					onOperation={editor.runRecipeOperation}
				/>
				{notice !== null && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
			</div>
			<SaveFooter dirty={editor.dirty} saving={busy} valid={canSave} error={editor.problem} onSave={() => void editor.save()} />
			<PromptPresetImportReviewDialog
				review={editor.review}
				busy={pending}
				onOrderSelect={(orderListId) => void editor.selectSillyTavernOrder(orderListId)}
				onCancel={editor.cancelSillyTavernReview}
				onCommit={() => void editor.commitSillyTavernReview()}
			/>
		</>
	);
}
