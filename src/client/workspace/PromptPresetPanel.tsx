import { useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationPromptPreset, PromptPresetSummary } from "../../shared/contract/prompt-preset";
import type { ConversationSummary } from "../conversation";
import { PanelHeader } from "../PanelHeader";
import { SaveFooter } from "../SaveFooter";
import { useNavigationRequest, useSaveGuard } from "../SaveGuard";
import { PromptPresetLibrarySection } from "./prompt-preset/PromptPresetLibrarySection";
import { PromptPresetRecipeEditor } from "./prompt-preset/PromptPresetRecipeEditor";
import { PromptPresetImportReviewDialog } from "./prompt-preset/PromptPresetImportReviewDialog";
import { presetLibraryQuery, presetRecipeQuery, presetRecipeScope, usePromptPresetEditor } from "./prompt-preset/usePromptPresetEditor";

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
	const client = useQueryClient();
	const [notice, setNotice] = useState<string | null>(null);
	const library = useQuery(presetLibraryQuery);
	const recipe = useQuery({ ...presetRecipeQuery(conversation.id, conversation.revision, presetId), placeholderData: keepPreviousData });
	let preset = recipe.data;
	if (recipe.isError && preset === undefined) {
		preset = client.getQueriesData<ConversationPromptPreset | null>({ queryKey: presetRecipeScope(conversation.id, presetId) })
			.findLast(([, value]) => value !== undefined)?.[1];
	}
	if (library.data !== undefined && preset) {
		return <PresetEditor key={preset.id} {...props} presets={library.data} preset={preset}
			recipePending={recipe.isPlaceholderData} notice={notice} onNotice={setNotice} />;
	}
	if (library.isError || recipe.isError || recipe.data === null) {
		return <p className="panel-body text-muted-foreground">The Prompt Preset library could not be loaded.</p>;
	}
	return <LoadingPresets />;
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

function PresetEditor({ mutationsDisabled, presets, notice, ...props }: PresetProps & {
	presets: PromptPresetSummary[];
	preset: ConversationPromptPreset;
	recipePending: boolean;
	notice: string | null;
	onNotice: (notice: string | null) => void;
}) {
	const editor = usePromptPresetEditor(props);
	const navigate = useNavigationRequest();
	const busy = editor.busy !== null;
	const pending = busy || props.recipePending;
	useSaveGuard({ dirty: editor.dirty, saving: busy, save: editor.save, discard: editor.discard });

	return (
		<>
			<div className="panel-body flex flex-col gap-6" inert={mutationsDisabled || undefined} aria-disabled={mutationsDisabled}>
				{props.presetId === undefined ? <PromptPresetLibrarySection
					presets={presets}
					selectedId={props.preset.id}
					pending={pending}
					problem={editor.problem}
					notice={notice}
					onSelect={(id) => navigate(() => void editor.applySelection(id))}
					onCommand={(command, successNotice) => void editor.runPresetCommand(command, successNotice)}
					onImportFile={(file) => void editor.importPresetFile(file)}
					onExport={(id, name) => void editor.exportSelectedPreset(id, name)}
				/> : <p className="font-medium">{props.preset.name}</p>}
				<PromptPresetRecipeEditor
					preset={props.preset}
					drafts={editor.drafts}
					pending={pending}
					editingDisabled={editor.busy === "change" || props.recipePending}
					problem={editor.problem}
					onDraftChange={editor.setDraft}
					onEnabledChange={editor.setEnabled}
					onDraftCancel={editor.clearDraft}
					onOperation={editor.runRecipeOperation}
				/>
				{notice !== null && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
			</div>
			<SaveFooter dirty={editor.dirty} saving={busy} valid={!props.recipePending} error={editor.problem} onSave={() => void editor.save()} />
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
